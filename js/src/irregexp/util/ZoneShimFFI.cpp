/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "irregexp/imported/regexp-ast.h"
#include "irregexp/util/ZoneShim.h"

extern "C" MOZ_EXPORT void js_irregexp_add_range_to_zone_list(
    void* list,  // ZoneList<CharacterRange>*
    void* zone,  // Zone*
    uint32_t start, uint32_t inclusiveEnd) {
  static_cast<v8::internal::ZoneList<v8::internal::CharacterRange>*>(list)->Add(
      v8::internal::CharacterRange::Range(start, inclusiveEnd),
      static_cast<v8::internal::Zone*>(zone));
}
