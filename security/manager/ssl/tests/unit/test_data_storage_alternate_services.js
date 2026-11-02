/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

do_get_profile(); // must be done before instantiating nsIDataStorageManager

const MAX_ENTRIES = 4096;

let dataStorage = Cc["@mozilla.org/security/datastoragemanager;1"]
  .getService(Ci.nsIDataStorageManager)
  .get(Ci.nsIDataStorageManager.AlternateServices);

add_task(function test_alternate_services_limit() {
  for (let i = 0; i < MAX_ENTRIES; i++) {
    dataStorage.put(`key${i}`, `value${i}`, Ci.nsIDataStorage.Persistent);
  }
  for (let i = 0; i < MAX_ENTRIES; i++) {
    Assert.equal(
      dataStorage.get(`key${i}`, Ci.nsIDataStorage.Persistent),
      `value${i}`
    );
  }

  dataStorage.put("one-more", "value", Ci.nsIDataStorage.Persistent);
  Assert.equal(
    dataStorage.get("one-more", Ci.nsIDataStorage.Persistent),
    "value"
  );
  Assert.equal(dataStorage.getAll().length, MAX_ENTRIES, "should evict");
});
