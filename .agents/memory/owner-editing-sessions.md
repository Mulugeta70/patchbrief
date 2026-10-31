---
name: Owner editing sessions
description: Why accepted owner credentials may enable page-only editing when browser storage fails
---

Server acceptance, not successful browser persistence, determines whether an owner may edit. If browser session storage fails after acceptance, permit editing in component memory and explicitly tell the owner it is for this page only.

**Why:** Browser storage can reject writes independently of authentication. Treating that exception as a rejected key hides editing controls even after the server accepted the key. This does not bypass authorization: the server must still check every write.

**How to apply:** Keep credential verification and browser persistence failures separate when changing the unlock experience; never report a storage failure as an invalid editing key.
