/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Portions Copyright Norbert Lindenberg 2011-2012. */

/**
 * Returns true if the input contains only ASCII alphabetical characters.
 */
function IsASCIIAlphaString(s) {
  assert(typeof s === "string", "IsASCIIAlphaString");

  for (var i = 0; i < s.length; i++) {
    var c = callFunction(std_String_charCodeAt, s, i);
    if (!((0x41 <= c && c <= 0x5a) || (0x61 <= c && c <= 0x7a))) {
      return false;
    }
  }
  return true;
}

/**
 * Canonicalizes a locale list.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.1.
 */
function CanonicalizeLocaleList(locales) {
  // Step 1.
  if (locales === undefined) {
    return [];
  }

  // Step 3 (and the remaining steps).
  var tag = intl_ValidateAndCanonicalizeLanguageTag(locales, false);
  if (tag !== null) {
    assert(
      typeof tag === "string",
      "intl_ValidateAndCanonicalizeLanguageTag returns a string value"
    );
    return [tag];
  }

  // Step 2.
  var seen = [];

  // Step 4.
  var O = ToObject(locales);

  // Step 5.
  var len = ToLength(O.length);

  // Step 6.
  var k = 0;

  // Step 7.
  while (k < len) {
    // Steps 7.a-c.
    if (k in O) {
      // Step 7.c.i.
      var kValue = O[k];

      // Step 7.c.ii.
      if (!(typeof kValue === "string" || IsObject(kValue))) {
        ThrowTypeError(JSMSG_INVALID_LOCALES_ELEMENT);
      }

      // Steps 7.c.iii-iv.
      var tag = intl_ValidateAndCanonicalizeLanguageTag(kValue, true);
      assert(
        typeof tag === "string",
        "ValidateAndCanonicalizeLanguageTag returns a string value"
      );

      // Step 7.c.v.
      if (callFunction(std_Array_indexOf, seen, tag) === -1) {
        DefineDataProperty(seen, seen.length, tag);
      }
    }

    // Step 7.d.
    k++;
  }

  // Step 8.
  return seen;
}

/**
 * Identical to BestAvailableLocale, but does not consider the default locale
 * during computation.
 */
function BestAvailableLocaleIgnoringDefault(availableLocales, locale) {
  return intl_BestAvailableLocale(availableLocales, locale, null);
}

/**
 * Extracts a property value from the provided options object, converts it to
 * the required type, checks whether it is one of a list of allowed values,
 * and fills in a fallback value if necessary.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.10.
 */
function GetOption(options, property, type, values, fallback) {
  // Step 1.
  var value = options[property];

  // Step 2.
  if (value !== undefined) {
    // Steps 2.a-c.
    if (type === "boolean") {
      value = TO_BOOLEAN(value);
    } else if (type === "string") {
      value = ToString(value);
    } else {
      assert(false, "GetOption");
    }

    // Step 2.d.
    if (
      values !== undefined &&
      callFunction(std_Array_indexOf, values, value) === -1
    ) {
      ThrowRangeError(JSMSG_INVALID_OPTION_VALUE, property, `"${value}"`);
    }

    // Step 2.e.
    return value;
  }

  // Step 3.
  return fallback;
}

/**
 * Extracts a property value from the provided options object, converts it to
 * a boolean or string, checks whether it is one of a list of allowed values,
 * and fills in a fallback value if necessary.
 */
function GetStringOrBooleanOption(
  options,
  property,
  stringValues,
  fallback
) {
  assert(IsObject(stringValues), "GetStringOrBooleanOption");

  // Step 1.
  var value = options[property];

  // Step 2.
  if (value === undefined) {
    return fallback;
  }

  // Step 3.
  if (value === true) {
    return true;
  }

  // Steps 4-5.
  if (!value) {
    return false;
  }

  // Step 6.
  value = ToString(value);

  // Step 7.
  if (callFunction(std_Array_indexOf, stringValues, value) === -1) {
    ThrowRangeError(JSMSG_INVALID_OPTION_VALUE, property, `"${value}"`);
  }

  // Step 8.
  return value;
}

/**
 * The abstract operation DefaultNumberOption converts value to a Number value,
 * checks whether it is in the allowed range, and fills in a fallback value if
 * necessary.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.11.
 */
function DefaultNumberOption(value, minimum, maximum, fallback) {
  assert(
    typeof minimum === "number" && (minimum | 0) === minimum,
    "DefaultNumberOption"
  );
  assert(
    typeof maximum === "number" && (maximum | 0) === maximum,
    "DefaultNumberOption"
  );
  assert(
    fallback === undefined ||
      (typeof fallback === "number" && (fallback | 0) === fallback),
    "DefaultNumberOption"
  );
  assert(
    fallback === undefined || (minimum <= fallback && fallback <= maximum),
    "DefaultNumberOption"
  );

  // Step 1.
  if (value === undefined) {
    return fallback;
  }

  // Step 2.
  value = TO_NUMBER(value);

  // Step 3.
  if (Number_isNaN(value) || value < minimum || value > maximum) {
    ThrowRangeError(JSMSG_INVALID_DIGITS_VALUE, value);
  }

  // Step 4.
  // Apply bitwise-or to convert -0 to +0 per ES2017, 5.2 and to ensure the
  // result is an int32 value.
  return std_Math_floor(value) | 0;
}

/**
 * Extracts a property value from the provided options object, converts it to a
 * Number value, checks whether it is in the allowed range, and fills in a
 * fallback value if necessary.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.12.
 */
function GetNumberOption(options, property, minimum, maximum, fallback) {
  // Steps 1-2.
  return DefaultNumberOption(options[property], minimum, maximum, fallback);
}

// Symbols in the self-hosting compartment can't be cloned, use a separate
// object to hold the actual symbol value.
// TODO: Can we add support to clone symbols?
var intlFallbackSymbolHolder = { value: undefined };

/**
 * The [[FallbackSymbol]] symbol of the %Intl% intrinsic object.
 *
 * This symbol is used to implement the legacy constructor semantics for
 * Intl.DateTimeFormat and Intl.NumberFormat.
 */
function intlFallbackSymbol() {
  var fallbackSymbol = intlFallbackSymbolHolder.value;
  if (!fallbackSymbol) {
    var Symbol = GetBuiltinConstructor("Symbol");
    fallbackSymbol = Symbol("IntlLegacyConstructedSymbol");
    intlFallbackSymbolHolder.value = fallbackSymbol;
  }
  return fallbackSymbol;
}

/**
 * Initializes the INTL_INTERNALS_OBJECT_SLOT of the given object.
 */
function initializeIntlObject(obj, type, lazyData) {
  assert(IsObject(obj), "Non-object passed to initializeIntlObject");
  assert(
    (type === "Collator" && intl_GuardToCollator(obj) !== null) ||
      (type === "DateTimeFormat" && intl_GuardToDateTimeFormat(obj) !== null) ||
      (type === "DisplayNames" && intl_GuardToDisplayNames(obj) !== null) ||
      (type === "DurationFormat" && intl_GuardToDurationFormat(obj) !== null) ||
      (type === "ListFormat" && intl_GuardToListFormat(obj) !== null) ||
      (type === "NumberFormat" && intl_GuardToNumberFormat(obj) !== null) ||
      (type === "PluralRules" && intl_GuardToPluralRules(obj) !== null) ||
      (type === "RelativeTimeFormat" &&
        intl_GuardToRelativeTimeFormat(obj) !== null) ||
      (type === "Segmenter" && intl_GuardToSegmenter(obj) !== null),
    "type must match the object's class"
  );
  assert(IsObject(lazyData), "non-object lazy data");

  // The meaning of an internals object for an object |obj| is as follows.
  //
  // The .type property indicates the type of Intl object that |obj| is. It
  // must be one of:
  // - Collator
  // - DateTimeFormat
  // - DisplayNames
  // - DurationFormat
  // - ListFormat
  // - NumberFormat
  // - PluralRules
  // - RelativeTimeFormat
  // - Segmenter
  //
  // The .lazyData property stores information needed to compute -- without
  // observable side effects -- the actual internal Intl properties of
  // |obj|.  If it is non-null, then the actual internal properties haven't
  // been computed, and .lazyData must be processed by
  // |setInternalProperties| before internal Intl property values are
  // available.  If it is null, then the .internalProps property contains an
  // object whose properties are the internal Intl properties of |obj|.

  var internals = std_Object_create(null);
  internals.type = type;
  internals.lazyData = lazyData;
  internals.internalProps = null;

  assert(
    UnsafeGetReservedSlot(obj, INTL_INTERNALS_OBJECT_SLOT) === undefined,
    "Internal slot already initialized?"
  );
  UnsafeSetReservedSlot(obj, INTL_INTERNALS_OBJECT_SLOT, internals);
}

/**
 * Set the internal properties object for an |internals| object previously
 * associated with lazy data.
 */
function setInternalProperties(internals, internalProps) {
  assert(IsObject(internals.lazyData), "lazy data must exist already");
  assert(IsObject(internalProps), "internalProps argument should be an object");

  // Set in reverse order so that the .lazyData nulling is a barrier.
  internals.internalProps = internalProps;
  internals.lazyData = null;
}

/**
 * Get the existing internal properties out of a non-newborn |internals|, or
 * null if none have been computed.
 */
function maybeInternalProperties(internals) {
  assert(IsObject(internals), "non-object passed to maybeInternalProperties");
  var lazyData = internals.lazyData;
  if (lazyData) {
    return null;
  }
  assert(
    IsObject(internals.internalProps),
    "missing lazy data and computed internals"
  );
  return internals.internalProps;
}

/**
 * Return |obj|'s internals object (*not* the object holding its internal
 * properties!), with structure specified above.
 *
 * Spec: ECMAScript Internationalization API Specification, 10.3.
 * Spec: ECMAScript Internationalization API Specification, 11.3.
 * Spec: ECMAScript Internationalization API Specification, 12.3.
 */
function getIntlObjectInternals(obj) {
  assert(IsObject(obj), "getIntlObjectInternals called with non-Object");
  assert(
    intl_GuardToCollator(obj) !== null ||
      intl_GuardToDateTimeFormat(obj) !== null ||
      intl_GuardToDisplayNames(obj) !== null ||
      intl_GuardToDurationFormat(obj) !== null ||
      intl_GuardToListFormat(obj) !== null ||
      intl_GuardToNumberFormat(obj) !== null ||
      intl_GuardToPluralRules(obj) !== null ||
      intl_GuardToRelativeTimeFormat(obj) !== null ||
      intl_GuardToSegmenter(obj) !== null,
    "getIntlObjectInternals called with non-Intl object"
  );

  var internals = UnsafeGetReservedSlot(obj, INTL_INTERNALS_OBJECT_SLOT);

  assert(IsObject(internals), "internals not an object");
  assert(hasOwn("type", internals), "missing type");
  assert(
    (internals.type === "Collator" && intl_GuardToCollator(obj) !== null) ||
      (internals.type === "DateTimeFormat" &&
        intl_GuardToDateTimeFormat(obj) !== null) ||
      (internals.type === "DisplayNames" &&
        intl_GuardToDisplayNames(obj) !== null) ||
      (internals.type === "DurationFormat" &&
        intl_GuardToDurationFormat(obj) !== null) ||
      (internals.type === "ListFormat" &&
        intl_GuardToListFormat(obj) !== null) ||
      (internals.type === "NumberFormat" &&
        intl_GuardToNumberFormat(obj) !== null) ||
      (internals.type === "PluralRules" &&
        intl_GuardToPluralRules(obj) !== null) ||
      (internals.type === "RelativeTimeFormat" &&
        intl_GuardToRelativeTimeFormat(obj) !== null) ||
      (internals.type === "Segmenter" &&
        intl_GuardToSegmenter(obj) !== null),
    "type must match the object's class"
  );
  assert(hasOwn("lazyData", internals), "missing lazyData");
  assert(hasOwn("internalProps", internals), "missing internalProps");

  return internals;
}

/**
 * Get the internal properties of known-Intl object |obj|.  For use only by
 * C++ code that knows what it's doing!
 */
function getInternals(obj) {
  var internals = getIntlObjectInternals(obj);

  // If internal properties have already been computed, use them.
  var internalProps = maybeInternalProperties(internals);
  if (internalProps) {
    return internalProps;
  }

  // Otherwise it's time to fully create them.
  var type = internals.type;
  if (type === "Collator") {
    internalProps = resolveCollatorInternals(internals.lazyData);
  } else if (type === "DateTimeFormat") {
    internalProps = resolveDateTimeFormatInternals(internals.lazyData);
  } else if (type === "DisplayNames") {
    internalProps = resolveDisplayNamesInternals(internals.lazyData);
  } else if (type === "DurationFormat") {
    internalProps = resolveDurationFormatInternals(internals.lazyData);
  } else if (type === "ListFormat") {
    internalProps = resolveListFormatInternals(internals.lazyData);
  } else if (type === "NumberFormat") {
    internalProps = resolveNumberFormatInternals(internals.lazyData);
  } else if (type === "PluralRules") {
    internalProps = resolvePluralRulesInternals(internals.lazyData);
  } else if (type === "RelativeTimeFormat") {
    internalProps = resolveRelativeTimeFormatInternals(internals.lazyData);
  } else {
    assert(type === "Segmenter", "unexpected Intl type");
    internalProps = resolveSegmenterInternals(internals.lazyData);
  }
  setInternalProperties(internals, internalProps);
  return internalProps;
}
