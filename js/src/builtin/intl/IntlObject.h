/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef builtin_intl_IntlObject_h
#define builtin_intl_IntlObject_h

#include "js/TypeDecls.h"

class JSLinearString;

namespace js {

extern const JSClass IntlClass;

/**
 * Compares a BCP 47 language tag against the locales in availableLocales and
 * returns the best available match -- or |undefined| if no match was found.
 * Uses the fallback mechanism of RFC 4647, section 3.4.
 *
 * The set of available locales consulted doesn't necessarily include the
 * default locale or any generalized forms of it (e.g. "de" is a more-general
 * form of "de-CH"). If you want to be sure to consider the default local and
 * its generalized forms (you usually will), pass the default locale as the
 * value of |defaultOrNull|; otherwise pass null.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.2.
 * Spec: RFC 4647, section 3.4.
 *
 * Usage: result = intl_BestAvailableLocale("Collator", locale, defaultOrNull)
 */
[[nodiscard]] extern bool intl_BestAvailableLocale(JSContext* cx, unsigned argc,
                                                   JS::Value* vp);

/**
 * Compares a BCP 47 language priority list against the set of locales in
 * availableLocales and determines the best available language to meet the
 * request. Options specified through Unicode extension subsequences are
 * ignored in the lookup, but information about such subsequences is returned
 * separately.
 *
 * This variant is based on the Lookup algorithm of RFC 4647 section 3.4.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.3.
 * Spec: RFC 4647, section 3.4.
 *
 * Usage: result = intl_LookupMatcher(constructor, requestedLocales, options)
 */
[[nodiscard]] extern bool intl_ResolveLocale(JSContext* cx, unsigned argc,
                                             JS::Value* vp);
}  // namespace js

#endif /* builtin_intl_IntlObject_h */
