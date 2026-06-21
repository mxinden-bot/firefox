#include "gtest/gtest.h"

#include "mozilla/net/DNSPacket.h"
#include "mozilla/Maybe.h"
#include "mozilla/Preferences.h"

#include <cstring>

using namespace mozilla;
using namespace mozilla::net;

void AssertDnsPadding(uint32_t PaddingLength, unsigned int WithPadding,
                      unsigned int WithoutPadding, bool DisableEcn,
                      const nsCString& host) {
  DNSPacket encoder;
  nsCString buf;

  ASSERT_EQ(Preferences::SetUint("network.trr.padding.length", PaddingLength),
            NS_OK);

  ASSERT_EQ(Preferences::SetBool("network.trr.padding", true), NS_OK);
  ASSERT_EQ(encoder.EncodeRequest(buf, host, 1, DisableEcn), NS_OK);
  ASSERT_EQ(buf.Length(), WithPadding);

  ASSERT_EQ(Preferences::SetBool("network.trr.padding", false), NS_OK);
  ASSERT_EQ(encoder.EncodeRequest(buf, host, 1, DisableEcn), NS_OK);
  ASSERT_EQ(buf.Length(), WithoutPadding);
}

TEST(TestDNSPacket, PaddingLenEcn)
{
  AssertDnsPadding(16, 48, 41, true, "a.de"_ns);
  AssertDnsPadding(16, 48, 42, true, "ab.de"_ns);
  AssertDnsPadding(16, 48, 43, true, "abc.de"_ns);
  AssertDnsPadding(16, 48, 44, true, "abcd.de"_ns);
  AssertDnsPadding(16, 64, 45, true, "abcde.de"_ns);
  AssertDnsPadding(16, 64, 46, true, "abcdef.de"_ns);
  AssertDnsPadding(16, 64, 47, true, "abcdefg.de"_ns);
  AssertDnsPadding(16, 64, 48, true, "abcdefgh.de"_ns);
}

TEST(TestDNSPacket, PaddingLenDisableEcn)
{
  AssertDnsPadding(16, 48, 22, false, "a.de"_ns);
  AssertDnsPadding(16, 48, 23, false, "ab.de"_ns);
  AssertDnsPadding(16, 48, 24, false, "abc.de"_ns);
  AssertDnsPadding(16, 48, 25, false, "abcd.de"_ns);
  AssertDnsPadding(16, 48, 26, false, "abcde.de"_ns);
  AssertDnsPadding(16, 48, 27, false, "abcdef.de"_ns);
  AssertDnsPadding(16, 48, 32, false, "abcdefghijk.de"_ns);
  AssertDnsPadding(16, 48, 33, false, "abcdefghijkl.de"_ns);
  AssertDnsPadding(16, 64, 34, false, "abcdefghijklm.de"_ns);
  AssertDnsPadding(16, 64, 35, false, "abcdefghijklmn.de"_ns);
}

namespace {

struct SoaSpec {
  uint32_t ttl;
  uint32_t minimum;
  bool validRdlen = true;
};

void Append16(nsTArray<uint8_t>& aBuf, uint16_t aValue) {
  aBuf.AppendElement(static_cast<uint8_t>(aValue >> 8));
  aBuf.AppendElement(static_cast<uint8_t>(aValue & 0xff));
}

void Append32(nsTArray<uint8_t>& aBuf, uint32_t aValue) {
  aBuf.AppendElement(static_cast<uint8_t>(aValue >> 24));
  aBuf.AppendElement(static_cast<uint8_t>((aValue >> 16) & 0xff));
  aBuf.AppendElement(static_cast<uint8_t>((aValue >> 8) & 0xff));
  aBuf.AppendElement(static_cast<uint8_t>(aValue & 0xff));
}

// Builds a minimal NODATA response for an AAAA query for "example.com" with the
// given SOA records in the authority section.
nsTArray<uint8_t> MakeNodataResponse(const nsTArray<SoaSpec>& aSoas) {
  nsTArray<uint8_t> buf;
  Append16(buf, 0x0000);                                 // ID
  Append16(buf, 0x8180);                                 // flags: QR + RD + RA
  Append16(buf, 1);                                      // QDCOUNT
  Append16(buf, 0);                                      // ANCOUNT
  Append16(buf, static_cast<uint16_t>(aSoas.Length()));  // NSCOUNT
  Append16(buf, 0);                                      // ARCOUNT

  // Question: example.com AAAA IN
  const uint8_t qname[] = {7,   'e', 'x', 'a', 'm', 'p', 'l',
                           'e', 3,   'c', 'o', 'm', 0};
  buf.AppendElements(qname, sizeof(qname));
  Append16(buf, TRRTYPE_AAAA);
  Append16(buf, 0x0001);  // class IN

  for (const SoaSpec& soa : aSoas) {
    Append16(buf, 0xC00C);       // NAME: pointer to the question's qname
    Append16(buf, TRRTYPE_SOA);  // TYPE = SOA
    Append16(buf, 0x0001);       // class IN
    Append32(buf, soa.ttl);      // SOA record TTL

    if (soa.validRdlen) {
      // RDATA: MNAME (root), RNAME (root), then five 32-bit fields.
      nsTArray<uint8_t> rdata;
      rdata.AppendElement(0);        // MNAME = root
      rdata.AppendElement(0);        // RNAME = root
      Append32(rdata, 1);            // SERIAL
      Append32(rdata, 3600);         // REFRESH
      Append32(rdata, 600);          // RETRY
      Append32(rdata, 86400);        // EXPIRE
      Append32(rdata, soa.minimum);  // MINIMUM
      Append16(buf, static_cast<uint16_t>(rdata.Length()));
      buf.AppendElements(rdata);
    } else {
      // RDLENGTH too short to contain a MINIMUM field.
      const uint8_t rdata[] = {0, 0, 0, 0, 0, 0, 0, 0};
      Append16(buf, sizeof(rdata));
      buf.AppendElements(rdata, sizeof(rdata));
    }
  }

  return buf;
}

Maybe<uint32_t> DecodeNegTtl(const nsTArray<SoaSpec>& aSoas) {
  nsTArray<uint8_t> response = MakeNodataResponse(aSoas);

  DNSPacket packet;
  MOZ_RELEASE_ASSERT(
      packet.FillBuffer([&](unsigned char aBuf[DNSPacket::MAX_SIZE]) -> int {
        memcpy(aBuf, response.Elements(), response.Length());
        return response.Length();
      }) == NS_OK);

  nsCString host("example.com"_ns);
  nsCString cname;
  DOHresp resp;
  TypeRecordResultType typeResult = AsVariant(Nothing());
  nsClassHashtable<nsCStringHashKey, DOHresp> additional;
  uint32_t ttl = 0;

  // A NODATA response decodes to NS_ERROR_UNKNOWN_HOST, but the SOA in the
  // authority section is parsed regardless, so GetNegativeTTL() is populated.
  (void)packet.Decode(host, TRRTYPE_AAAA, cname, true, resp, typeResult,
                      additional, ttl);
  return packet.GetNegativeTTL();
}

}  // namespace

TEST(TestDNSPacket, NegativeTtlFromSOA)
{
  // MINIMUM smaller than the SOA record TTL: min() picks MINIMUM.
  EXPECT_EQ(DecodeNegTtl(nsTArray<SoaSpec>{SoaSpec{600, 300}}), Some(300u));

  // SOA record TTL smaller than MINIMUM: min() picks the record TTL.
  EXPECT_EQ(DecodeNegTtl(nsTArray<SoaSpec>{SoaSpec{120, 300}}), Some(120u));

  // No SOA in the authority section: nothing to derive.
  EXPECT_EQ(DecodeNegTtl(nsTArray<SoaSpec>{}), Nothing());

  // SOA with RDLENGTH too short to hold a MINIMUM: ignored.
  EXPECT_EQ(DecodeNegTtl(nsTArray<SoaSpec>{SoaSpec{600, 300, false}}),
            Nothing());

  // Multiple SOAs: the smallest derived value wins.
  EXPECT_EQ(
      DecodeNegTtl(nsTArray<SoaSpec>{SoaSpec{600, 300}, SoaSpec{600, 100}}),
      Some(100u));
}

TEST(TestDNSPacket, PaddingLengths)
{
  AssertDnsPadding(0, 45, 41, true, "a.de"_ns);
  AssertDnsPadding(1, 45, 41, true, "a.de"_ns);
  AssertDnsPadding(2, 46, 41, true, "a.de"_ns);
  AssertDnsPadding(3, 45, 41, true, "a.de"_ns);
  AssertDnsPadding(4, 48, 41, true, "a.de"_ns);
  AssertDnsPadding(16, 48, 41, true, "a.de"_ns);
  AssertDnsPadding(32, 64, 41, true, "a.de"_ns);
  AssertDnsPadding(42, 84, 41, true, "a.de"_ns);
  AssertDnsPadding(52, 52, 41, true, "a.de"_ns);
  AssertDnsPadding(80, 80, 41, true, "a.de"_ns);
  AssertDnsPadding(128, 128, 41, true, "a.de"_ns);
  AssertDnsPadding(256, 256, 41, true, "a.de"_ns);
  AssertDnsPadding(1024, 1024, 41, true, "a.de"_ns);
  AssertDnsPadding(1025, 1024, 41, true, "a.de"_ns);
}
