/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// jsdoc cannot name a `#`-private class member, so a doc comment on one yields
// a doclet with an empty longname, which sphinx_js then fails to parse. Private
// members don't reach our docs, so they are safe to skip.

export const handlers = {
  newDoclet({ doclet }) {
    if (!doclet.longname) {
      doclet.undocumented = true;
    }
  },
};
