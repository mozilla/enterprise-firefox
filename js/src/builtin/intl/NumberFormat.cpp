/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Intl.NumberFormat implementation. */

#include "builtin/intl/NumberFormat.h"

#include "mozilla/Assertions.h"
#include "mozilla/FloatingPoint.h"
#include "mozilla/intl/Locale.h"
#include "mozilla/intl/MeasureUnit.h"
#include "mozilla/intl/MeasureUnitGenerated.h"
#include "mozilla/intl/NumberFormat.h"
#include "mozilla/intl/NumberingSystem.h"
#include "mozilla/intl/NumberRangeFormat.h"
#include "mozilla/intl/PluralRules.h"
#include "mozilla/Span.h"
#include "mozilla/TextUtils.h"

#include <algorithm>
#include <stddef.h>
#include <stdint.h>
#include <string>
#include <string_view>
#include <type_traits>

#include "builtin/Array.h"
#include "builtin/intl/CommonFunctions.h"
#include "builtin/intl/CurrencyDataGenerated.h"
#include "builtin/intl/FormatBuffer.h"
#include "builtin/intl/LanguageTag.h"
#include "builtin/intl/LocaleNegotiation.h"
#include "builtin/intl/ParameterNegotiation.h"
#include "builtin/intl/PluralRules.h"
#include "builtin/intl/RelativeTimeFormat.h"
#include "builtin/intl/UsingEnum.h"
#include "builtin/Number.h"
#include "gc/GCContext.h"
#include "js/CharacterEncoding.h"
#include "js/PropertySpec.h"
#include "js/RootingAPI.h"
#include "js/TypeDecls.h"
#include "util/Text.h"
#include "vm/BigIntType.h"
#include "vm/GlobalObject.h"
#include "vm/JSContext.h"
#include "vm/PlainObject.h"  // js::PlainObject
#include "vm/StringType.h"

#include "vm/GeckoProfiler-inl.h"
#include "vm/JSObject-inl.h"
#include "vm/NativeObject-inl.h"

using namespace js;
using namespace js::intl;

const JSClassOps NumberFormatObject::classOps_ = {
    nullptr,                       // addProperty
    nullptr,                       // delProperty
    nullptr,                       // enumerate
    nullptr,                       // newEnumerate
    nullptr,                       // resolve
    nullptr,                       // mayResolve
    NumberFormatObject::finalize,  // finalize
    nullptr,                       // call
    nullptr,                       // construct
    nullptr,                       // trace
};

const JSClass NumberFormatObject::class_ = {
    "Intl.NumberFormat",
    JSCLASS_HAS_RESERVED_SLOTS(NumberFormatObject::SLOT_COUNT) |
        JSCLASS_HAS_CACHED_PROTO(JSProto_NumberFormat) |
        JSCLASS_BACKGROUND_FINALIZE,
    &NumberFormatObject::classOps_,
    &NumberFormatObject::classSpec_,
};

const JSClass& NumberFormatObject::protoClass_ = PlainObject::class_;

static bool numberFormat_supportedLocalesOf(JSContext* cx, unsigned argc,
                                            Value* vp);

static bool numberFormat_format(JSContext* cx, unsigned argc, Value* vp);

static bool numberFormat_formatToParts(JSContext* cx, unsigned argc, Value* vp);

static bool numberFormat_formatRange(JSContext* cx, unsigned argc, Value* vp);

static bool numberFormat_formatRangeToParts(JSContext* cx, unsigned argc,
                                            Value* vp);

static bool numberFormat_resolvedOptions(JSContext* cx, unsigned argc,
                                         Value* vp);

static bool numberFormat_toSource(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setString(cx->names().NumberFormat);
  return true;
}

static const JSFunctionSpec numberFormat_static_methods[] = {
    JS_FN("supportedLocalesOf", numberFormat_supportedLocalesOf, 1, 0),
    JS_FS_END,
};

static const JSFunctionSpec numberFormat_methods[] = {
    JS_FN("resolvedOptions", numberFormat_resolvedOptions, 0, 0),
    JS_FN("formatToParts", numberFormat_formatToParts, 1, 0),
    JS_FN("formatRange", numberFormat_formatRange, 2, 0),
    JS_FN("formatRangeToParts", numberFormat_formatRangeToParts, 2, 0),
    JS_FN("toSource", numberFormat_toSource, 0, 0),
    JS_FS_END,
};

static const JSPropertySpec numberFormat_properties[] = {
    JS_PSG("format", numberFormat_format, 0),
    JS_STRING_SYM_PS(toStringTag, "Intl.NumberFormat", JSPROP_READONLY),
    JS_PS_END,
};

static bool NumberFormat(JSContext* cx, unsigned argc, Value* vp);

const ClassSpec NumberFormatObject::classSpec_ = {
    GenericCreateConstructor<NumberFormat, 0, gc::AllocKind::FUNCTION>,
    GenericCreatePrototype<NumberFormatObject>,
    numberFormat_static_methods,
    nullptr,
    numberFormat_methods,
    numberFormat_properties,
    nullptr,
    ClassSpec::DontDefineConstructor,
};

/**
 * IsWellFormedCurrencyCode ( currency )
 *
 * Verifies that the given string is a well-formed ISO 4217 currency code in
 * normalized case.
 */
static constexpr bool IsWellFormedNormalizedCurrencyCode(
    std::string_view currency) {
  return currency.length() == 3 &&
         std::all_of(currency.begin(), currency.end(),
                     mozilla::IsAsciiUppercaseAlpha<char>);
}

#ifdef DEBUG
/**
 * IsWellFormedCurrencyCode ( currency )
 *
 * Verifies that the given string is a well-formed ISO 4217 currency code in
 * normalized case.
 */
static constexpr bool IsWellFormedNormalizedCurrencyCode(
    const NumberFormatUnitOptions::Currency& currency) {
  return IsWellFormedNormalizedCurrencyCode(
      std::string_view{currency.code, std::size(currency.code)});
}
#endif

/**
 * Hash a well-formed currency in normalized case.
 */
static constexpr int32_t CurrencyHash(std::string_view currency) {
  MOZ_ASSERT(IsWellFormedNormalizedCurrencyCode(currency));

  // Prefer small hash values because they can be more likely encoded as
  // literals in assembly code.
  //
  // Each character is in A..Z, so there are 26 possible values, which can be
  // represented in five bits. That means 15 bits are needed in total to hash a
  // currency, which fits in int16 and therefore can be encoded directly for
  // x86 and arm64 assembly.
  return ((currency[0] - 'A') << 10) | ((currency[1] - 'A') << 5) |
         ((currency[2] - 'A') << 0);
}

constexpr auto operator""_curr(const char* code, size_t n) {
  return CurrencyHash({code, n});
}

/**
 * CurrencyDigits ( currency )
 *
 * Returns the number of decimal digits to be used for the given currency.
 */
static int32_t CurrencyDigits(
    const NumberFormatUnitOptions::Currency& currency) {
  // Step 1.
  MOZ_ASSERT(IsWellFormedNormalizedCurrencyCode(currency));

  // Step 2.
  switch (CurrencyHash(currency.code)) {
#define CURRENCY(currency, digits) \
  case #currency##_curr:           \
    return digits;
    CURRENCIES_WITH_NON_DEFAULT_DIGITS(CURRENCY)
#undef CURRENCY
    default:
      break;
  }

  // Defaults to two digits if no override was found.
  return 2;
}

/**
 * IsWellFormedCurrencyCode ( currency )
 *
 * Verifies that the given string is a well-formed ISO 4217 currency code.
 */
static bool ToWellFormedCurrencyCode(
    JSContext* cx, Handle<JSString*> currency,
    NumberFormatUnitOptions::Currency* result) {
  static constexpr size_t CurrencyLength = 3;

  static_assert(std::extent_v<decltype(result->code)> == CurrencyLength);

  // Step 1.
  if (currency->length() == CurrencyLength) {
    auto* linear = currency->ensureLinear(cx);
    if (!linear) {
      return false;
    }

    if (StringIsAscii(linear)) {
      // Copy characters into (stack-allocated) array.
      char chars[CurrencyLength] = {};
      CopyChars(reinterpret_cast<JS::Latin1Char*>(chars), *linear);

      // Step 2.
      auto toAsciiUpperCase = [](auto ch) -> char {
        if (mozilla::IsAsciiLowercaseAlpha(ch)) {
          return ch - 0x20;
        }
        return ch;
      };
      std::transform(std::begin(chars), std::end(chars), std::begin(chars),
                     toAsciiUpperCase);

      // String view over the currency code characters.
      std::string_view code{chars, CurrencyLength};

      // Steps 3-4.
      //
      // If the currency is well-formed and normalized, copy it to the result.
      if (IsWellFormedNormalizedCurrencyCode(code)) {
        std::copy_n(chars, CurrencyLength, result->code);
        return true;
      }
    }
  }

  if (auto chars = QuoteString(cx, currency)) {
    JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                              JSMSG_INVALID_CURRENCY_CODE, chars.get());
  }
  return false;
}

/**
 * Return the maximum number of characters needed for unit identifiers.
 */
static constexpr size_t MaxUnitLength() {
  size_t length = 0;
  for (const auto& unit : mozilla::intl::simpleMeasureUnits) {
    length = std::max(length, std::char_traits<char>::length(unit.name));
  }
  return length * 2 + std::char_traits<char>::length("-per-");
}

/**
 * IsSanctionedSingleUnitIdentifier ( unitIdentifier )
 *
 * Verifies that the given string is a sanctioned simple core unit identifier.
 *
 * Also see: https://unicode.org/reports/tr35/tr35-general.html#Unit_Elements
 */
static bool IsSanctionedSingleUnitIdentifier(std::string_view unitIdentifier) {
  return std::ranges::binary_search(
      std::begin(mozilla::intl::simpleMeasureUnits),
      std::end(mozilla::intl::simpleMeasureUnits), unitIdentifier,
      [](const auto& a, const auto& b) { return a < b; },
      [](const auto& unit) { return std::string_view{unit.name}; });
}

/**
 * IsWellFormedUnitIdentifier ( unitIdentifier )
 *
 * Verifies that the given string is a well-formed core unit identifier as
 * defined in UTS #35, Part 2, Section 6. In addition to obeying the UTS #35
 * core unit identifier syntax, |unitIdentifier| must be one of the identifiers
 * sanctioned by UTS #35 or be a compound unit composed of two sanctioned simple
 * units.
 */
static bool IsWellFormedUnitIdentifier(std::string_view unitIdentifier) {
  // Step 1.
  if (IsSanctionedSingleUnitIdentifier(unitIdentifier)) {
    return true;
  }

  // Step 2.
  constexpr std::string_view separator = "-per-";
  auto pos = unitIdentifier.find(separator);

  // Step 3.
  if (pos == std::string_view::npos) {
    return false;
  }

  // Step 4.
  //
  // Sanctioned single unit identifiers don't include the substring "-per-",
  // so we can skip searching for the second "-per-" substring.

  // Step 5.
  auto numerator = unitIdentifier.substr(0, pos);

  // Step 6.
  auto denominator = unitIdentifier.substr(pos + separator.length());

  // Steps 7-8.
  return IsSanctionedSingleUnitIdentifier(numerator) &&
         IsSanctionedSingleUnitIdentifier(denominator);
}

/**
 * Return true if |unitIdentifier| is an available unit identifier.
 */
static bool IsAvailableUnitIdentifier(JSContext* cx,
                                      std::string_view unitIdentifier,
                                      bool* result) {
  MOZ_ASSERT(IsWellFormedUnitIdentifier(unitIdentifier));

#if DEBUG || MOZ_SYSTEM_ICU
  auto units = mozilla::intl::MeasureUnit::GetAvailable();
  if (units.isErr()) {
    ReportInternalError(cx, units.unwrapErr());
    return false;
  }

  constexpr std::string_view separator = "-per-";

  auto numerator = unitIdentifier;
  auto denominator = unitIdentifier;

  // Compound units are separated by "-per-".
  auto pos = unitIdentifier.find(separator);
  if (pos != std::string_view::npos) {
    numerator = unitIdentifier.substr(0, pos);
    denominator = unitIdentifier.substr(pos + separator.length());
  }

  bool foundNumerator = false;
  bool foundDenominator = false;
  for (auto unit : units.unwrap()) {
    if (unit.isErr()) {
      ReportInternalError(cx);
      return false;
    }
    auto unitSpan = unit.unwrap();
    auto unitView = std::string_view{unitSpan.data(), unitSpan.size()};

    if (numerator == unitView) {
      foundNumerator = true;
    }
    if (denominator == unitView) {
      foundDenominator = true;
    }

    if (foundNumerator && foundDenominator) {
      *result = true;
      return true;
    }
  }

#  if MOZ_SYSTEM_ICU
  // A system ICU may support fewer measurement units, so we need to make sure
  // the unit is actually supported.
  *result = false;
  return true;
#  else
  // Otherwise assert in debug-mode if the unit is not supported.
  MOZ_ASSERT(false,
             "unitIdentifier is sanctioned but not supported. Did you forget "
             "to update intl/icu/data_filter.json to include the unit (and any "
             "implicit compound units)? For example 'speed/kilometer-per-hour' "
             "is implied by 'length/kilometer' and 'duration/hour' and must "
             "therefore also be present.");
#  endif
#else
  // All sanctioned units are guaranteed to be available when not using system
  // ICU.
  *result = true;
  return true;
#endif
}

/**
 * IsWellFormedUnitIdentifier ( unitIdentifier )
 *
 * If |unitIdentifier| is a well-formed unit identifier, return the unit in
 * |result|. Otherwise throw a RangeError.
 */
static bool ToWellFormedUnitIdentifier(JSContext* cx,
                                       Handle<JSString*> unitIdentifier,
                                       NumberFormatUnitOptions::Unit* result) {
  static constexpr size_t UnitLength = MaxUnitLength();

  static_assert(std::extent_v<decltype(result->name)> > UnitLength,
                "large enough to hold the largest unit and a NUL terminator");

  if (unitIdentifier->length() <= UnitLength) {
    auto* linear = unitIdentifier->ensureLinear(cx);
    if (!linear) {
      return false;
    }

    if (StringIsAscii(linear)) {
      // Copy characters into (stack-allocated) array.
      char chars[UnitLength] = {};
      CopyChars(reinterpret_cast<JS::Latin1Char*>(chars), *linear);

      // String view over the unit identifier characters.
      std::string_view unit{chars, unitIdentifier->length()};

      // If the unit is well-formed and available, copy it to the result.
      if (IsWellFormedUnitIdentifier(unit)) {
        bool isAvailable;
        if (!IsAvailableUnitIdentifier(cx, unit, &isAvailable)) {
          return false;
        }
        if (isAvailable) {
          unit.copy(result->name, std::size(result->name));
          result->name[unit.length()] = '\0';
          return true;
        }
      }
    }
  }

  // Throw a RangeError for invalid or unavailable units.
  if (auto chars = QuoteString(cx, unitIdentifier)) {
    JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                              JSMSG_INVALID_UNIT_IDENTIFIER, chars.get());
  }
  return false;
}

static constexpr std::string_view RoundingModeToString(
    NumberFormatDigitOptions::RoundingMode roundingMode) {
#ifndef USING_ENUM
  using enum NumberFormatDigitOptions::RoundingMode;
#else
  USING_ENUM(NumberFormatDigitOptions::RoundingMode, Ceil, Floor, Expand, Trunc,
             HalfCeil, HalfFloor, HalfExpand, HalfTrunc, HalfEven);
#endif
  switch (roundingMode) {
    case Ceil:
      return "ceil";
    case Floor:
      return "floor";
    case Expand:
      return "expand";
    case Trunc:
      return "trunc";
    case HalfCeil:
      return "halfCeil";
    case HalfFloor:
      return "halfFloor";
    case HalfExpand:
      return "halfExpand";
    case HalfTrunc:
      return "halfTrunc";
    case HalfEven:
      return "halfEven";
  }
  MOZ_CRASH("invalid number format rounding mode");
}

static constexpr std::string_view RoundingPriorityToString(
    NumberFormatDigitOptions::RoundingPriority roundingPriority) {
#ifndef USING_ENUM
  using enum NumberFormatDigitOptions::RoundingPriority;
#else
  USING_ENUM(NumberFormatDigitOptions::RoundingPriority, Auto, MorePrecision,
             LessPrecision);
#endif
  switch (roundingPriority) {
    case Auto:
      return "auto";
    case MorePrecision:
      return "morePrecision";
    case LessPrecision:
      return "lessPrecision";
  }
  MOZ_CRASH("invalid number format rounding priority");
}

static constexpr std::string_view TrailingZeroDisplayToString(
    NumberFormatDigitOptions::TrailingZeroDisplay trailingZeroDisplay) {
#ifndef USING_ENUM
  using enum NumberFormatDigitOptions::TrailingZeroDisplay;
#else
  USING_ENUM(NumberFormatDigitOptions::TrailingZeroDisplay, Auto,
             StripIfInteger);
#endif
  switch (trailingZeroDisplay) {
    case Auto:
      return "auto";
    case StripIfInteger:
      return "stripIfInteger";
  }
  MOZ_CRASH("invalid number format trailing zero display");
}

static constexpr std::string_view NumberFormatStyleToString(
    NumberFormatUnitOptions::Style style) {
#ifndef USING_ENUM
  using enum NumberFormatUnitOptions::Style;
#else
  USING_ENUM(NumberFormatUnitOptions::Style, Decimal, Percent, Currency, Unit);
#endif
  switch (style) {
    case Decimal:
      return "decimal";
    case Percent:
      return "percent";
    case Currency:
      return "currency";
    case Unit:
      return "unit";
  }
  MOZ_CRASH("invalid number format style");
}

static constexpr std::string_view CurrencyDisplayToString(
    NumberFormatUnitOptions::CurrencyDisplay currencyDisplay) {
#ifndef USING_ENUM
  using enum NumberFormatUnitOptions::CurrencyDisplay;
#else
  USING_ENUM(NumberFormatUnitOptions::CurrencyDisplay, Symbol, NarrowSymbol,
             Code, Name);
#endif
  switch (currencyDisplay) {
    case Symbol:
      return "symbol";
    case NarrowSymbol:
      return "narrowSymbol";
    case Code:
      return "code";
    case Name:
      return "name";
  }
  MOZ_CRASH("invalid number format currency display");
}

static constexpr std::string_view CurrencySignToString(
    NumberFormatUnitOptions::CurrencySign currencySign) {
#ifndef USING_ENUM
  using enum NumberFormatUnitOptions::CurrencySign;
#else
  USING_ENUM(NumberFormatUnitOptions::CurrencySign, Standard, Accounting);
#endif
  switch (currencySign) {
    case Standard:
      return "standard";
    case Accounting:
      return "accounting";
  }
  MOZ_CRASH("invalid number format currency sign");
}

static constexpr std::string_view UnitDisplayToString(
    NumberFormatUnitOptions::UnitDisplay unitDisplay) {
#ifndef USING_ENUM
  using enum NumberFormatUnitOptions::UnitDisplay;
#else
  USING_ENUM(NumberFormatUnitOptions::UnitDisplay, Short, Narrow, Long);
#endif
  switch (unitDisplay) {
    case Short:
      return "short";
    case Narrow:
      return "narrow";
    case Long:
      return "long";
  }
  MOZ_CRASH("invalid number format unit display");
}

static constexpr std::string_view NotationToString(
    NumberFormatOptions::Notation notation) {
#ifndef USING_ENUM
  using enum NumberFormatOptions::Notation;
#else
  USING_ENUM(NumberFormatOptions::Notation, Standard, Scientific, Engineering,
             Compact);
#endif
  switch (notation) {
    case Standard:
      return "standard";
    case Scientific:
      return "scientific";
    case Engineering:
      return "engineering";
    case Compact:
      return "compact";
  }
  MOZ_CRASH("invalid number format notation");
}

static constexpr std::string_view CompactDisplayToString(
    NumberFormatOptions::CompactDisplay compactDisplay) {
#ifndef USING_ENUM
  using enum NumberFormatOptions::CompactDisplay;
#else
  USING_ENUM(NumberFormatOptions::CompactDisplay, Short, Long);
#endif
  switch (compactDisplay) {
    case Short:
      return "short";
    case Long:
      return "long";
  }
  MOZ_CRASH("invalid number format compact display");
}

enum class UseGroupingOption { Auto, Min2, Always, True, False };

static constexpr std::string_view UseGroupingOptionToString(
    UseGroupingOption useGrouping) {
#ifndef USING_ENUM
  using enum UseGroupingOption;
#else
  USING_ENUM(UseGroupingOption, Auto, Min2, Always, True, False);
#endif
  switch (useGrouping) {
    case Auto:
      return "auto";
    case Min2:
      return "min2";
    case Always:
      return "always";
    case True:
      return "true";
    case False:
      return "false";
  }
  MOZ_CRASH("invalid number format use grouping");
}

static constexpr std::string_view UseGroupingToString(
    NumberFormatOptions::UseGrouping useGrouping) {
#ifndef USING_ENUM
  using enum NumberFormatOptions::UseGrouping;
#else
  USING_ENUM(NumberFormatOptions::UseGrouping, Auto, Min2, Always, Never);
#endif
  switch (useGrouping) {
    case Auto:
      return "auto";
    case Min2:
      return "min2";
    case Always:
      return "always";
    case Never:
      return "never";
  }
  MOZ_CRASH("invalid number format use grouping");
}

static constexpr auto ToUseGroupingOption(
    NumberFormatOptions::UseGrouping useGrouping) {
#ifndef USING_ENUM
  using enum UseGroupingOption;
#else
  USING_ENUM(UseGroupingOption, Auto, Min2, Always, False);
#endif
  switch (useGrouping) {
    case NumberFormatOptions::UseGrouping::Auto:
      return Auto;
    case NumberFormatOptions::UseGrouping::Min2:
      return Min2;
    case NumberFormatOptions::UseGrouping::Always:
      return Always;
    case NumberFormatOptions::UseGrouping::Never:
      return False;
  }
  MOZ_CRASH("invalid number format use grouping");
}

static constexpr auto ToUseGrouping(
    UseGroupingOption useGrouping,
    NumberFormatOptions::UseGrouping defaultUseGrouping) {
#ifndef USING_ENUM
  using enum NumberFormatOptions::UseGrouping;
#else
  USING_ENUM(NumberFormatOptions::UseGrouping, Auto, Min2, Always);
#endif
  switch (useGrouping) {
    case UseGroupingOption::Auto:
      return Auto;
    case UseGroupingOption::Min2:
      return Min2;
    case UseGroupingOption::Always:
      return Always;
    case UseGroupingOption::True:
    case UseGroupingOption::False:
      return defaultUseGrouping;
  }
  MOZ_CRASH("invalid number format use grouping");
}

static constexpr std::string_view SignDisplayToString(
    NumberFormatOptions::SignDisplay signDisplay) {
#ifndef USING_ENUM
  using enum NumberFormatOptions::SignDisplay;
#else
  USING_ENUM(NumberFormatOptions::SignDisplay, Auto, Never, Always, ExceptZero,
             Negative);
#endif
  switch (signDisplay) {
    case Auto:
      return "auto";
    case Never:
      return "never";
    case Always:
      return "always";
    case ExceptZero:
      return "exceptZero";
    case Negative:
      return "negative";
  }
  MOZ_CRASH("invalid number format sign display");
}

/**
 * SetNumberFormatDigitOptions ( intlObj, options, mnfdDefault, mxfdDefault,
 * notation )
 */
bool js::intl::SetNumberFormatDigitOptions(
    JSContext* cx, NumberFormatDigitOptions& obj, Handle<JSObject*> options,
    int32_t mnfdDefault, int32_t mxfdDefault,
    NumberFormatOptions::Notation notation) {
  MOZ_ASSERT(0 <= mnfdDefault && mnfdDefault <= mxfdDefault);

  // Step 1.
  int32_t mnid;
  if (!GetNumberOption(cx, options, cx->names().minimumIntegerDigits, 1, 21, 1,
                       &mnid)) {
    return false;
  }

  // Step 2.
  Rooted<JS::Value> mnfd(cx);
  if (!GetProperty(cx, options, options, cx->names().minimumFractionDigits,
                   &mnfd)) {
    return false;
  }

  // Step 3.
  Rooted<JS::Value> mxfd(cx);
  if (!GetProperty(cx, options, options, cx->names().maximumFractionDigits,
                   &mxfd)) {
    return false;
  }

  // Step 4.
  Rooted<JS::Value> mnsd(cx);
  if (!GetProperty(cx, options, options, cx->names().minimumSignificantDigits,
                   &mnsd)) {
    return false;
  }

  // Step 5.
  Rooted<JS::Value> mxsd(cx);
  if (!GetProperty(cx, options, options, cx->names().maximumSignificantDigits,
                   &mxsd)) {
    return false;
  }

  // Step 6.
  obj.minimumIntegerDigits = static_cast<int8_t>(mnid);

  // Step 7.
  int32_t roundingIncrement;
  if (!GetNumberOption(cx, options, cx->names().roundingIncrement, 1, 5000, 1,
                       &roundingIncrement)) {
    return false;
  }

  // Step 8.
  switch (roundingIncrement) {
    case 1:
    case 2:
    case 5:
    case 10:
    case 20:
    case 25:
    case 50:
    case 100:
    case 200:
    case 250:
    case 500:
    case 1000:
    case 2000:
    case 2500:
    case 5000:
      break;
    default: {
      Int32ToCStringBuf cbuf;
      const char* str = Int32ToCString(&cbuf, roundingIncrement);
      MOZ_ASSERT(str);
      JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                JSMSG_INVALID_OPTION_VALUE, "roundingIncrement",
                                str);
      return false;
    }
  }

  // Step 9.
  static constexpr auto roundingModes = MapOptions<RoundingModeToString>(
      NumberFormatDigitOptions::RoundingMode::Ceil,
      NumberFormatDigitOptions::RoundingMode::Floor,
      NumberFormatDigitOptions::RoundingMode::Expand,
      NumberFormatDigitOptions::RoundingMode::Trunc,
      NumberFormatDigitOptions::RoundingMode::HalfCeil,
      NumberFormatDigitOptions::RoundingMode::HalfFloor,
      NumberFormatDigitOptions::RoundingMode::HalfExpand,
      NumberFormatDigitOptions::RoundingMode::HalfTrunc,
      NumberFormatDigitOptions::RoundingMode::HalfEven);
  NumberFormatDigitOptions::RoundingMode roundingMode;
  if (!GetStringOption(cx, options, cx->names().roundingMode, roundingModes,
                       NumberFormatDigitOptions::RoundingMode::HalfExpand,
                       &roundingMode)) {
    return false;
  }

  // Step 10.
  static constexpr auto roundingPriorities =
      MapOptions<RoundingPriorityToString>(
          NumberFormatDigitOptions::RoundingPriority::Auto,
          NumberFormatDigitOptions::RoundingPriority::MorePrecision,
          NumberFormatDigitOptions::RoundingPriority::LessPrecision);
  NumberFormatDigitOptions::RoundingPriority roundingPriority;
  if (!GetStringOption(cx, options, cx->names().roundingPriority,
                       roundingPriorities,
                       NumberFormatDigitOptions::RoundingPriority::Auto,
                       &roundingPriority)) {
    return false;
  }

  // Step 11.
  static constexpr auto trailingZeroDisplays =
      MapOptions<TrailingZeroDisplayToString>(
          NumberFormatDigitOptions::TrailingZeroDisplay::Auto,
          NumberFormatDigitOptions::TrailingZeroDisplay::StripIfInteger);
  NumberFormatDigitOptions::TrailingZeroDisplay trailingZeroDisplay;
  if (!GetStringOption(cx, options, cx->names().trailingZeroDisplay,
                       trailingZeroDisplays,
                       NumberFormatDigitOptions::TrailingZeroDisplay::Auto,
                       &trailingZeroDisplay)) {
    return false;
  }

  // Step 12. (This step is a note.)

  // Step 13.
  if (roundingIncrement != 1) {
    mxfdDefault = mnfdDefault;
  }

  // Step 14.
  obj.roundingIncrement = static_cast<int16_t>(roundingIncrement);

  // Step 15.
  obj.roundingMode = roundingMode;

  // Step 16.
  obj.trailingZeroDisplay = trailingZeroDisplay;

  // Step 17.
  bool hasSd = !(mnsd.isUndefined() && mxsd.isUndefined());

  // Step 18.
  bool hasFd = !(mnfd.isUndefined() && mxfd.isUndefined());

  // Step 19.
  bool needSd = true;

  // Step 20.
  bool needFd = true;

  // Step 21.
  if (roundingPriority == NumberFormatDigitOptions::RoundingPriority ::Auto) {
    // Step 21.a.
    needSd = hasSd;

    // Step 21.b.
    if (needSd ||
        (!hasFd && notation == NumberFormatOptions::Notation::Compact)) {
      needFd = false;
    }
  }

  // Step 22.
  if (needSd) {
    // Steps 22.a-b.
    if (hasSd) {
      // Step 22.a.i.
      int32_t minimumSignificantDigits;
      if (!DefaultNumberOption(cx, mnsd, 1, 21, 1, &minimumSignificantDigits)) {
        return false;
      }
      obj.minimumSignificantDigits =
          static_cast<int8_t>(minimumSignificantDigits);

      // Step 22.a.i.
      int32_t maximumSignificantDigits;
      if (!DefaultNumberOption(cx, mxsd, obj.minimumSignificantDigits, 21, 21,
                               &maximumSignificantDigits)) {
        return false;
      }
      obj.maximumSignificantDigits =
          static_cast<int8_t>(maximumSignificantDigits);
    } else {
      // Step 22.b.i.
      obj.minimumSignificantDigits = 1;

      // Step 22.b.ii.
      obj.maximumSignificantDigits = 21;
    }
  }

  // Step 23.
  if (needFd) {
    // Steps 23.a-b.
    if (hasFd) {
      // Step 23.a.i.
      mozilla::Maybe<int32_t> minFracDigits{};
      if (!DefaultNumberOption(cx, mnfd, 0, 100, &minFracDigits)) {
        return false;
      }

      // Step 23.a.ii.
      mozilla::Maybe<int32_t> maxFracDigits{};
      if (!DefaultNumberOption(cx, mxfd, 0, 100, &maxFracDigits)) {
        return false;
      }

      MOZ_ASSERT(minFracDigits.isSome() || maxFracDigits.isSome(),
                 "mnfd and mxfd can't both be undefined");

      // Step 23.a.iii.
      if (minFracDigits.isNothing()) {
        minFracDigits = mozilla::Some(std::min(mnfdDefault, *maxFracDigits));
      }

      // Step 23.a.iv.
      else if (maxFracDigits.isNothing()) {
        maxFracDigits = mozilla::Some(std::max(mxfdDefault, *minFracDigits));
      }

      // Step 23.a.v.
      else if (*minFracDigits > *maxFracDigits) {
        Int32ToCStringBuf cbuf;
        const char* str = Int32ToCString(&cbuf, roundingIncrement);
        MOZ_ASSERT(str);
        JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                  JSMSG_INVALID_DIGITS_VALUE, str);
        return false;
      }

      // Step 23.a.vi.
      obj.minimumFractionDigits = static_cast<int8_t>(*minFracDigits);

      // Step 23.a.vii.
      obj.maximumFractionDigits = static_cast<int8_t>(*maxFracDigits);
    } else {
      // Step 23.b.i.
      obj.minimumFractionDigits = static_cast<int8_t>(mnfdDefault);

      // Step 23.b.ii.
      obj.maximumFractionDigits = static_cast<int8_t>(mxfdDefault);
    }
  } else {
    // Set to a negative value to mark fraction digits as absent.
    obj.minimumFractionDigits = -1;
    obj.maximumFractionDigits = -1;
  }

  // Steps 24-28.
  if (!needSd && !needFd) {
    MOZ_ASSERT(!hasSd, "bad significant digits in fallback case");
    MOZ_ASSERT(
        roundingPriority == NumberFormatDigitOptions::RoundingPriority::Auto,
        "bad rounding in fallback case");
    MOZ_ASSERT(notation == NumberFormatOptions::Notation::Compact,
               "bad notation in fallback case");

    // Steps 24.a-f.
    obj.minimumFractionDigits = 0;
    obj.maximumFractionDigits = 0;
    obj.minimumSignificantDigits = 1;
    obj.maximumSignificantDigits = 2;
    obj.roundingPriority =
        NumberFormatDigitOptions::RoundingPriority::MorePrecision;
  } else {
    // Steps 25-28.
    //
    // Our implementation stores |roundingPriority| instead of using
    // [[RoundingType]].
    obj.roundingPriority = roundingPriority;
  }

  // Step 29.
  if (roundingIncrement != 1) {
    // Step 29.a.
    //
    // [[RoundingType]] is `fractionDigits` if |roundingPriority| is equal to
    // "auto" and |hasSd| is false.
    if (roundingPriority != NumberFormatDigitOptions::RoundingPriority::Auto ||
        hasSd) {
      const char* conflictingOption =
          !mnsd.isUndefined()   ? "minimumSignificantDigits"
          : !mxsd.isUndefined() ? "maximumSignificantDigits"
                                : "roundingPriority";
      JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                JSMSG_INVALID_NUMBER_OPTION,
                                "roundingIncrement", conflictingOption);
      return false;
    }

    // Step 29.b.
    //
    // Minimum and maximum fraction digits must be equal.
    if (obj.minimumFractionDigits != obj.maximumFractionDigits) {
      JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                JSMSG_UNEQUAL_FRACTION_DIGITS);
      return false;
    }
  }

  // Step 30.
  return true;
}

/**
 * SetNumberFormatUnitOptions ( intlObj, options )
 */
static bool SetNumberFormatUnitOptions(JSContext* cx,
                                       NumberFormatUnitOptions& obj,
                                       Handle<JSObject*> options) {
  // Step 1.
  static constexpr auto styles = MapOptions<NumberFormatStyleToString>(
      NumberFormatUnitOptions::Style::Decimal,
      NumberFormatUnitOptions::Style::Percent,
      NumberFormatUnitOptions::Style::Currency,
      NumberFormatUnitOptions::Style::Unit);
  NumberFormatUnitOptions::Style style;
  if (!GetStringOption(cx, options, cx->names().style, styles,
                       NumberFormatUnitOptions::Style::Decimal, &style)) {
    return false;
  }

  // Step 2.
  obj.style = style;

  // Step 3.
  Rooted<JSString*> currency(cx);
  if (!GetStringOption(cx, options, cx->names().currency, &currency)) {
    return false;
  }

  // Steps 4-5.
  if (!currency) {
    // Step 4.a.
    if (style == NumberFormatUnitOptions::Style::Currency) {
      JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                JSMSG_UNDEFINED_CURRENCY);
      return false;
    }
  } else {
    // Step 5.a.
    if (!ToWellFormedCurrencyCode(cx, currency, &obj.currency)) {
      return false;
    }
  }

  // Step 6.
  static constexpr auto currencyDisplays = MapOptions<CurrencyDisplayToString>(
      NumberFormatUnitOptions::CurrencyDisplay::Code,
      NumberFormatUnitOptions::CurrencyDisplay::Symbol,
      NumberFormatUnitOptions::CurrencyDisplay::NarrowSymbol,
      NumberFormatUnitOptions::CurrencyDisplay::Name);
  if (!GetStringOption(cx, options, cx->names().currencyDisplay,
                       currencyDisplays,
                       NumberFormatUnitOptions::CurrencyDisplay::Symbol,
                       &obj.currencyDisplay)) {
    return false;
  }

  // Step 7.
  static constexpr auto currencySigns = MapOptions<CurrencySignToString>(
      NumberFormatUnitOptions::CurrencySign::Standard,
      NumberFormatUnitOptions::CurrencySign::Accounting);
  if (!GetStringOption(cx, options, cx->names().currencySign, currencySigns,
                       NumberFormatUnitOptions::CurrencySign::Standard,
                       &obj.currencySign)) {
    return false;
  }

  // Step 8.
  Rooted<JSString*> unit(cx);
  if (!GetStringOption(cx, options, cx->names().unit, &unit)) {
    return false;
  }

  // Steps 9-10.
  if (!unit) {
    // Step 9.a.
    if (style == NumberFormatUnitOptions::Style::Unit) {
      JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                JSMSG_UNDEFINED_UNIT);
      return false;
    }
  } else {
    // Step 10.a.
    if (!ToWellFormedUnitIdentifier(cx, unit, &obj.unit)) {
      return false;
    }
  }

  // Step 11.
  static constexpr auto unitDisplays = MapOptions<UnitDisplayToString>(
      NumberFormatUnitOptions::UnitDisplay::Short,
      NumberFormatUnitOptions::UnitDisplay::Narrow,
      NumberFormatUnitOptions::UnitDisplay::Long);
  if (!GetStringOption(cx, options, cx->names().unitDisplay, unitDisplays,
                       NumberFormatUnitOptions::UnitDisplay::Short,
                       &obj.unitDisplay)) {
    return false;
  }

  // Steps 12-13. (Not applicable in our implementation.)

  // Step 14.
  return true;
}

/**
 * Intl.NumberFormat ( [ locales [ , options ] ] )
 */
static bool InitializeNumberFormat(JSContext* cx,
                                   Handle<NumberFormatObject*> numberFormat,
                                   Handle<JS::Value> locales,
                                   Handle<JS::Value> optionsValue) {
  // Steps 1-2. (Performed in caller)

  // Step 3. (Inlined ResolveOptions)

  // ResolveOptions, step 1.
  Rooted<LocalesList> requestedLocales(cx, cx);
  if (!CanonicalizeLocaleList(cx, locales, &requestedLocales)) {
    return false;
  }

  Rooted<ArrayObject*> requestedLocalesArray(
      cx, LocalesListToArray(cx, requestedLocales));
  if (!requestedLocalesArray) {
    return false;
  }
  numberFormat->setRequestedLocales(requestedLocalesArray);

  auto nfOptions = cx->make_unique<NumberFormatOptions>();
  if (!nfOptions) {
    return false;
  }

  if (!optionsValue.isUndefined()) {
    // ResolveOptions, steps 2-3.
    Rooted<JSObject*> options(cx, JS::ToObject(cx, optionsValue));
    if (!options) {
      return false;
    }

    // ResolveOptions, step 4.
    LocaleMatcher matcher;
    if (!GetLocaleMatcherOption(cx, options, &matcher)) {
      return false;
    }

    // ResolveOptions, step 5.
    //
    // This implementation only supports the "lookup" locale matcher, therefore
    // the "localeMatcher" option doesn't need to be stored.

    // ResolveOptions, step 6.
    Rooted<JSLinearString*> numberingSystem(cx);
    if (!GetUnicodeExtensionOption(cx, options,
                                   UnicodeExtensionKey::NumberingSystem,
                                   &numberingSystem)) {
      return false;
    }
    if (numberingSystem) {
      numberFormat->setNumberingSystem(numberingSystem);
    }

    // ResolveOptions, step 7. (Not applicable)

    // ResolveOptions, step 8. (Performed in ResolveLocale)

    // ResolveOptions, step 9. (Return)

    // Step 4. (Not applicable when ResolveOptions is inlined.)

    // Step 5-8. (Performed in ResolveLocale)

    // Step 9.
    if (!SetNumberFormatUnitOptions(cx, nfOptions->unitOptions, options)) {
      return false;
    }

    // Step 10.
    auto style = nfOptions->unitOptions.style;

    // Step 11.
    static constexpr auto notations =
        MapOptions<NotationToString>(NumberFormatOptions::Notation::Standard,
                                     NumberFormatOptions::Notation::Scientific,
                                     NumberFormatOptions::Notation::Engineering,
                                     NumberFormatOptions::Notation::Compact);
    NumberFormatOptions::Notation notation;
    if (!GetStringOption(cx, options, cx->names().notation, notations,
                         NumberFormatOptions::Notation::Standard, &notation)) {
      return false;
    }

    // Step 12.
    nfOptions->notation = notation;

    // Steps 13-14.
    int32_t mnfdDefault;
    int32_t mxfdDefault;
    if (style == NumberFormatUnitOptions::Style::Currency &&
        notation == NumberFormatOptions::Notation::Standard) {
      // Steps 13.a-b.
      int32_t cDigits = CurrencyDigits(nfOptions->unitOptions.currency);

      // Step 13.c.
      mnfdDefault = cDigits;

      // Step 13.d.
      mxfdDefault = cDigits;
    } else {
      // Step 14.a.
      mnfdDefault = 0;

      // Steps 14.b-c.
      mxfdDefault = style == NumberFormatUnitOptions::Style::Percent ? 0 : 3;
    }

    // Step 15.
    if (!SetNumberFormatDigitOptions(cx, nfOptions->digitOptions, options,
                                     mnfdDefault, mxfdDefault, notation)) {
      return false;
    }

    // Step 16 and 18.a.
    static constexpr auto compactDisplays = MapOptions<CompactDisplayToString>(
        NumberFormatOptions::CompactDisplay::Short,
        NumberFormatOptions::CompactDisplay::Long);
    if (!GetStringOption(cx, options, cx->names().compactDisplay,
                         compactDisplays,
                         NumberFormatOptions::CompactDisplay::Short,
                         &nfOptions->compactDisplay)) {
      return false;
    }

    // Step 17.
    auto defaultUseGrouping = NumberFormatOptions::UseGrouping::Auto;

    // Step 18.
    if (notation == NumberFormatOptions::Notation::Compact) {
      // Step 18.a. (Handled above)

      // Step 18.b.
      defaultUseGrouping = NumberFormatOptions::UseGrouping::Min2;
    }

    // Steps 19-20.
    static constexpr auto useGroupings = MapOptions<UseGroupingOptionToString>(
        UseGroupingOption::Min2, UseGroupingOption::Auto,
        UseGroupingOption::Always, UseGroupingOption::True,
        UseGroupingOption::False);
    mozilla::Variant<bool, UseGroupingOption> useGrouping{false};
    if (!GetBooleanOrStringNumberFormatOption(
            cx, options, cx->names().useGrouping, useGroupings,
            ToUseGroupingOption(defaultUseGrouping), &useGrouping)) {
      return false;
    }

    // Steps 21-23.
    nfOptions->useGrouping = useGrouping.match(
        [](bool grouping) {
          if (grouping) {
            return NumberFormatOptions::UseGrouping::Always;
          }
          return NumberFormatOptions::UseGrouping::Never;
        },
        [&](auto grouping) {
          return ToUseGrouping(grouping, defaultUseGrouping);
        });

    // Steps 24-25.
    static constexpr auto signDisplays = MapOptions<SignDisplayToString>(
        NumberFormatOptions::SignDisplay::Auto,
        NumberFormatOptions::SignDisplay::Never,
        NumberFormatOptions::SignDisplay::Always,
        NumberFormatOptions::SignDisplay::ExceptZero,
        NumberFormatOptions::SignDisplay::Negative);
    if (!GetStringOption(cx, options, cx->names().signDisplay, signDisplays,
                         NumberFormatOptions::SignDisplay::Auto,
                         &nfOptions->signDisplay)) {
      return false;
    }
  } else {
    static constexpr NumberFormatOptions defaultOptions = {
        .digitOptions =
            {
                .roundingIncrement = 1,
                .minimumIntegerDigits = 1,
                .minimumFractionDigits = 0,
                .maximumFractionDigits = 3,
                .minimumSignificantDigits = 0,
                .maximumSignificantDigits = 0,
                .roundingMode =
                    NumberFormatDigitOptions::RoundingMode::HalfExpand,
                .roundingPriority =
                    NumberFormatDigitOptions::RoundingPriority::Auto,
                .trailingZeroDisplay =
                    NumberFormatDigitOptions::TrailingZeroDisplay::Auto,
            },
        .unitOptions =
            {
                .style = NumberFormatUnitOptions::Style::Decimal,
            },
        .notation = NumberFormatOptions::Notation::Standard,
        .useGrouping = NumberFormatOptions::UseGrouping::Auto,
        .signDisplay = NumberFormatOptions::SignDisplay::Auto,
    };

    // Initialize using the default number format options.
    *nfOptions = defaultOptions;
  }
  numberFormat->setOptions(nfOptions.release());
  AddCellMemory(numberFormat, sizeof(NumberFormatOptions),
                MemoryUse::IntlOptions);

  // Step 26. (Performed in caller)

  // Step 27.
  return true;
}

/**
 * Intl.NumberFormat ( [ locales [ , options ] ] )
 */
static bool NumberFormat(JSContext* cx, unsigned argc, Value* vp) {
  AutoJSConstructorProfilerEntry pseudoFrame(cx, "Intl.NumberFormat");
  CallArgs args = CallArgsFromVp(argc, vp);

  // Step 1 (Handled by OrdinaryCreateFromConstructor fallback code).

  // Step 2 (Inlined 9.1.14, OrdinaryCreateFromConstructor).
  Rooted<JSObject*> proto(cx);
  if (!GetPrototypeFromBuiltinConstructor(cx, args, JSProto_NumberFormat,
                                          &proto)) {
    return false;
  }

  Rooted<NumberFormatObject*> numberFormat(cx);
  numberFormat = NewObjectWithClassProto<NumberFormatObject>(cx, proto);
  if (!numberFormat) {
    return false;
  }

  // Steps 2-25.
  if (!InitializeNumberFormat(cx, numberFormat, args.get(0), args.get(1))) {
    return false;
  }

  // Steps 26-27.
  return ChainLegacyIntlFormat(cx, JSProto_NumberFormat, args, numberFormat);
}

NumberFormatObject* js::intl::CreateNumberFormat(JSContext* cx,
                                                 Handle<Value> locales,
                                                 Handle<Value> options) {
  Rooted<NumberFormatObject*> numberFormat(
      cx, NewBuiltinClassInstance<NumberFormatObject>(cx));
  if (!numberFormat) {
    return nullptr;
  }

  if (!InitializeNumberFormat(cx, numberFormat, locales, options)) {
    return nullptr;
  }
  return numberFormat;
}

NumberFormatObject* js::intl::GetOrCreateNumberFormat(JSContext* cx,
                                                      Handle<Value> locales,
                                                      Handle<Value> options) {
  // Try to use a cached instance when |locales| is either undefined or a
  // string, and |options| is undefined.
  if ((locales.isUndefined() || locales.isString()) && options.isUndefined()) {
    Rooted<JSLinearString*> locale(cx);
    if (locales.isString()) {
      locale = locales.toString()->ensureLinear(cx);
      if (!locale) {
        return nullptr;
      }
    }
    return cx->global()->globalIntlData().getOrCreateNumberFormat(cx, locale);
  }

  // Create a new Intl.NumberFormat instance.
  return CreateNumberFormat(cx, locales, options);
}

void js::intl::NumberFormatObject::finalize(JS::GCContext* gcx, JSObject* obj) {
  auto* numberFormat = &obj->as<NumberFormatObject>();
  auto* nf = numberFormat->getNumberFormatter();
  auto* nrf = numberFormat->getNumberRangeFormatter();

  if (auto* options = numberFormat->getOptions()) {
    gcx->delete_(obj, options, MemoryUse::IntlOptions);
  }

  if (nf) {
    RemoveICUCellMemory(gcx, obj, NumberFormatObject::EstimatedMemoryUse);
    // This was allocated using `new` in mozilla::intl::NumberFormat, so we
    // delete here.
    delete nf;
  }

  if (nrf) {
    RemoveICUCellMemory(gcx, obj, EstimatedRangeFormatterMemoryUse);
    // This was allocated using `new` in mozilla::intl::NumberRangeFormat, so we
    // delete here.
    delete nrf;
  }
}

/**
 * Resolve the actual locale to finish initialization of the NumberFormat.
 */
static bool ResolveLocale(JSContext* cx,
                          Handle<NumberFormatObject*> numberFormat) {
  // Return if the locale was already resolved.
  if (numberFormat->isLocaleResolved()) {
    return true;
  }

  Rooted<ArrayObject*> requestedLocales(
      cx, &numberFormat->getRequestedLocales()->as<ArrayObject>());

  // %Intl.NumberFormat%.[[RelevantExtensionKeys]] is « "nu" ».
  mozilla::EnumSet<UnicodeExtensionKey> relevantExtensionKeys{
      UnicodeExtensionKey::NumberingSystem,
  };

  // Initialize locale options from constructor arguments.
  Rooted<LocaleOptions> localeOptions(cx);
  if (auto* nu = numberFormat->getNumberingSystem()) {
    localeOptions.setUnicodeExtension(UnicodeExtensionKey::NumberingSystem, nu);
  }

  // Use the default locale data.
  auto localeData = LocaleData::Default;

  // Resolve the actual locale.
  Rooted<ResolvedLocale> resolved(cx);
  if (!ResolveLocale(cx, AvailableLocaleKind::NumberFormat, requestedLocales,
                     localeOptions, relevantExtensionKeys, localeData,
                     &resolved)) {
    return false;
  }

  // Finish initialization by setting the actual locale and extensions.
  auto* locale = resolved.toLocale(cx);
  if (!locale) {
    return false;
  }
  numberFormat->setLocale(locale);

  auto nu = resolved.extension(UnicodeExtensionKey::NumberingSystem);
  MOZ_ASSERT(nu, "resolved numbering system is non-null");
  numberFormat->setNumberingSystem(nu);

  MOZ_ASSERT(numberFormat->isLocaleResolved(), "locale successfully resolved");
  return true;
}

static UniqueChars NumberFormatLocale(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat) {
  MOZ_ASSERT(numberFormat->isLocaleResolved());

  // ICU expects numberingSystem as a Unicode locale extensions on locale.

  JS::RootedVector<UnicodeExtensionKeyword> keywords(cx);
  if (!keywords.emplaceBack("nu", numberFormat->getNumberingSystem())) {
    return nullptr;
  }

  Rooted<JSLinearString*> locale(cx, numberFormat->getLocale());
  return FormatLocale(cx, locale, keywords);
}

static auto ToCurrencyDisplay(
    NumberFormatUnitOptions::CurrencyDisplay currencyDisplay) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::CurrencyDisplay;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::CurrencyDisplay, Symbol,
             NarrowSymbol, Code, Name);
#endif
  switch (currencyDisplay) {
    case NumberFormatUnitOptions::CurrencyDisplay::Symbol:
      return Symbol;
    case NumberFormatUnitOptions::CurrencyDisplay::NarrowSymbol:
      return NarrowSymbol;
    case NumberFormatUnitOptions::CurrencyDisplay::Code:
      return Code;
    case NumberFormatUnitOptions::CurrencyDisplay::Name:
      return Name;
  }
  MOZ_CRASH("invalid currency display");
}

static auto ToUnitDisplay(NumberFormatUnitOptions::UnitDisplay unitDisplay) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::UnitDisplay;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::UnitDisplay, Short, Narrow,
             Long);
#endif
  switch (unitDisplay) {
    case NumberFormatUnitOptions::UnitDisplay::Short:
      return Short;
    case NumberFormatUnitOptions::UnitDisplay::Narrow:
      return Narrow;
    case NumberFormatUnitOptions::UnitDisplay::Long:
      return Long;
  }
  MOZ_CRASH("invalid unit display");
}

static auto ToRoundingMode(
    NumberFormatDigitOptions::RoundingMode roundingMode) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::RoundingMode;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::RoundingMode, Ceil, Floor,
             Expand, Trunc, HalfCeil, HalfFloor, HalfExpand, HalfTrunc,
             HalfEven);
#endif
  switch (roundingMode) {
    case NumberFormatDigitOptions::RoundingMode::Ceil:
      return Ceil;
    case NumberFormatDigitOptions::RoundingMode::Floor:
      return Floor;
    case NumberFormatDigitOptions::RoundingMode::Expand:
      return Expand;
    case NumberFormatDigitOptions::RoundingMode::Trunc:
      return Trunc;
    case NumberFormatDigitOptions::RoundingMode::HalfCeil:
      return HalfCeil;
    case NumberFormatDigitOptions::RoundingMode::HalfFloor:
      return HalfFloor;
    case NumberFormatDigitOptions::RoundingMode::HalfExpand:
      return HalfExpand;
    case NumberFormatDigitOptions::RoundingMode::HalfTrunc:
      return HalfTrunc;
    case NumberFormatDigitOptions::RoundingMode::HalfEven:
      return HalfEven;
  }
  MOZ_CRASH("invalid rounding mode");
}

static auto ToSignDisplay(NumberFormatOptions::SignDisplay signDisplay) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::SignDisplay;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::SignDisplay, Auto, Never,
             Always, ExceptZero, Negative);
#endif
  switch (signDisplay) {
    case NumberFormatOptions::SignDisplay::Auto:
      return Auto;
    case NumberFormatOptions::SignDisplay::Never:
      return Never;
    case NumberFormatOptions::SignDisplay::Always:
      return Always;
    case NumberFormatOptions::SignDisplay::ExceptZero:
      return ExceptZero;
    case NumberFormatOptions::SignDisplay::Negative:
      return Negative;
  }
  MOZ_CRASH("invalid sign display");
}

static auto ToAccountingSignDisplay(
    NumberFormatOptions::SignDisplay signDisplay) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::SignDisplay;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::SignDisplay, Accounting, Never,
             AccountingAlways, AccountingExceptZero, AccountingNegative);
#endif
  switch (signDisplay) {
    case NumberFormatOptions::SignDisplay::Auto:
      return Accounting;
    case NumberFormatOptions::SignDisplay::Never:
      return Never;
    case NumberFormatOptions::SignDisplay::Always:
      return AccountingAlways;
    case NumberFormatOptions::SignDisplay::ExceptZero:
      return AccountingExceptZero;
    case NumberFormatOptions::SignDisplay::Negative:
      return AccountingNegative;
  }
  MOZ_CRASH("invalid sign display");
}

static auto ToNotation(NumberFormatOptions::Notation notation,
                       NumberFormatOptions::CompactDisplay compactDisplay) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::Notation;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::Notation, Standard, Scientific,
             Engineering, CompactShort, CompactLong);
#endif
  switch (notation) {
    case NumberFormatOptions::Notation::Standard:
      return Standard;
    case NumberFormatOptions::Notation::Scientific:
      return Scientific;
    case NumberFormatOptions::Notation::Engineering:
      return Engineering;
    case NumberFormatOptions::Notation::Compact:
      switch (compactDisplay) {
        case NumberFormatOptions::CompactDisplay::Short:
          return CompactShort;
        case NumberFormatOptions::CompactDisplay::Long:
          return CompactLong;
      }
      MOZ_CRASH("invalid compact display");
  }
  MOZ_CRASH("invalid notation");
}

static auto ToGrouping(NumberFormatOptions::UseGrouping useGrouping) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::Grouping;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::Grouping, Auto, Min2, Always,
             Never);
#endif
  switch (useGrouping) {
    case NumberFormatOptions::UseGrouping::Auto:
      return Auto;
    case NumberFormatOptions::UseGrouping::Min2:
      return Min2;
    case NumberFormatOptions::UseGrouping::Always:
      return Always;
    case NumberFormatOptions::UseGrouping::Never:
      return Never;
  }
  MOZ_CRASH("invalid grouping");
}

static auto ToRoundingPriority(
    NumberFormatDigitOptions::RoundingPriority roundingPriority) {
#ifndef USING_ENUM
  using enum mozilla::intl::NumberFormatOptions::RoundingPriority;
#else
  USING_ENUM(mozilla::intl::NumberFormatOptions::RoundingPriority, Auto,
             MorePrecision, LessPrecision);
#endif
  switch (roundingPriority) {
    case NumberFormatDigitOptions::RoundingPriority::Auto:
      return Auto;
    case NumberFormatDigitOptions::RoundingPriority::MorePrecision:
      return MorePrecision;
    case NumberFormatDigitOptions::RoundingPriority::LessPrecision:
      return LessPrecision;
  }
  MOZ_CRASH("invalid rounding priority");
}

struct MozNumberFormatOptions : public mozilla::intl::NumberRangeFormatOptions {
  static_assert(std::is_base_of_v<mozilla::intl::NumberFormatOptions,
                                  mozilla::intl::NumberRangeFormatOptions>);

  char currencyChars[3] = {};
  char unitChars[MaxUnitLength() + 1] = {};
};

static void SetNumberFormatUnitOptions(
    const NumberFormatUnitOptions& unitOptions,
    MozNumberFormatOptions& options) {
  switch (unitOptions.style) {
    case NumberFormatUnitOptions::Style::Decimal: {
      return;
    }

    case NumberFormatUnitOptions::Style::Percent: {
      options.mPercent = true;
      return;
    }

    case NumberFormatUnitOptions::Style::Currency: {
      static constexpr size_t CurrencyLength = 3;

      static_assert(std::extent_v<decltype(unitOptions.currency.code)> ==
                    CurrencyLength);
      static_assert(std::extent_v<decltype(options.currencyChars)> ==
                    CurrencyLength);

      std::copy_n(unitOptions.currency.code, CurrencyLength,
                  options.currencyChars);

      auto display = ToCurrencyDisplay(unitOptions.currencyDisplay);

      options.mCurrency = mozilla::Some(std::make_pair(
          std::string_view(options.currencyChars, CurrencyLength), display));
      return;
    }

    case NumberFormatUnitOptions::Style::Unit: {
      static constexpr size_t UnitLength = MaxUnitLength();

      static_assert(
          std::extent_v<decltype(unitOptions.unit.name)> > UnitLength,
          "large enough to hold the largest unit and a NUL terminator");
      static_assert(
          std::extent_v<decltype(options.unitChars)> > UnitLength,
          "large enough to hold the largest unit and a NUL terminator");

      std::copy_n(unitOptions.unit.name, UnitLength, options.unitChars);

      auto display = ToUnitDisplay(unitOptions.unitDisplay);

      options.mUnit = mozilla::Some(
          std::make_pair(std::string_view(options.unitChars), display));
      return;
    }
  }
  MOZ_CRASH("invalid number format style");
}

template <class Options>
static void SetNumberFormatDigitOptions(
    const NumberFormatDigitOptions& digitOptions, Options& options) {
  bool hasSignificantDigits = digitOptions.minimumSignificantDigits > 0;
  if (hasSignificantDigits) {
    MOZ_ASSERT(digitOptions.minimumSignificantDigits <=
                   digitOptions.maximumSignificantDigits,
               "significant digits are consistent");

    options.mSignificantDigits =
        mozilla::Some(std::make_pair(digitOptions.minimumSignificantDigits,
                                     digitOptions.maximumSignificantDigits));
  }

  bool hasFractionDigits = digitOptions.minimumFractionDigits >= 0;
  if (hasFractionDigits) {
    MOZ_ASSERT(digitOptions.minimumFractionDigits <=
                   digitOptions.maximumFractionDigits,
               "fraction digits are consistent");

    options.mFractionDigits =
        mozilla::Some(std::make_pair(digitOptions.minimumFractionDigits,
                                     digitOptions.maximumFractionDigits));
  }

  options.mMinIntegerDigits = mozilla::Some(digitOptions.minimumIntegerDigits);
  options.mRoundingIncrement = digitOptions.roundingIncrement;
  options.mRoundingMode = ToRoundingMode(digitOptions.roundingMode);
  options.mRoundingPriority = ToRoundingPriority(digitOptions.roundingPriority);
  options.mStripTrailingZero =
      digitOptions.trailingZeroDisplay ==
      NumberFormatDigitOptions::TrailingZeroDisplay::StripIfInteger;
}

static void SetNumberFormatOptions(const NumberFormatOptions& nfOptions,
                                   MozNumberFormatOptions& options) {
  SetNumberFormatDigitOptions(nfOptions.digitOptions, options);
  SetNumberFormatUnitOptions(nfOptions.unitOptions, options);

  options.mNotation = ToNotation(nfOptions.notation, nfOptions.compactDisplay);
  options.mGrouping = ToGrouping(nfOptions.useGrouping);
  if (nfOptions.unitOptions.style == NumberFormatUnitOptions::Style::Currency &&
      nfOptions.unitOptions.currencySign ==
          NumberFormatUnitOptions::CurrencySign::Accounting) {
    options.mSignDisplay = ToAccountingSignDisplay(nfOptions.signDisplay);
  } else {
    options.mSignDisplay = ToSignDisplay(nfOptions.signDisplay);
  }

  options.mRangeCollapse =
      mozilla::intl::NumberRangeFormatOptions::RangeCollapse::Auto;
  options.mRangeIdentityFallback = mozilla::intl::NumberRangeFormatOptions::
      RangeIdentityFallback::Approximately;
}

void js::intl::SetPluralRulesOptions(
    const PluralRulesOptions& plOptions,
    mozilla::intl::PluralRulesOptions& options) {
  ::SetNumberFormatDigitOptions(plOptions.digitOptions, options);

  options.mNotation = ToNotation(plOptions.notation, plOptions.compactDisplay);
}

/**
 * Returns a new mozilla::intl::Number[Range]Format with the locale and number
 * formatting options of the given NumberFormat, or a nullptr if
 * initialization failed.
 */
template <class Formatter>
static Formatter* NewNumberFormat(JSContext* cx,
                                  Handle<NumberFormatObject*> numberFormat) {
  if (!ResolveLocale(cx, numberFormat)) {
    return nullptr;
  }
  auto nfOptions = *numberFormat->getOptions();

  auto locale = NumberFormatLocale(cx, numberFormat);
  if (!locale) {
    return nullptr;
  }

  MozNumberFormatOptions options;
  SetNumberFormatOptions(nfOptions, options);

  auto result = Formatter::TryCreate(locale.get(), options);
  if (result.isErr()) {
    ReportInternalError(cx, result.unwrapErr());
    return nullptr;
  }
  return result.unwrap().release();
}

static mozilla::intl::NumberFormat* GetOrCreateNumberFormat(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat) {
  // Obtain a cached mozilla::intl::NumberFormat object.
  if (auto* nf = numberFormat->getNumberFormatter()) {
    return nf;
  }

  auto* nf = NewNumberFormat<mozilla::intl::NumberFormat>(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }
  numberFormat->setNumberFormatter(nf);

  AddICUCellMemory(numberFormat, NumberFormatObject::EstimatedMemoryUse);
  return nf;
}

static mozilla::intl::NumberRangeFormat* GetOrCreateNumberRangeFormat(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat) {
  // Obtain a cached mozilla::intl::NumberRangeFormat object.
  if (auto* nrf = numberFormat->getNumberRangeFormatter()) {
    return nrf;
  }

  auto* nrf =
      NewNumberFormat<mozilla::intl::NumberRangeFormat>(cx, numberFormat);
  if (!nrf) {
    return nullptr;
  }
  numberFormat->setNumberRangeFormatter(nrf);

  AddICUCellMemory(numberFormat,
                   NumberFormatObject::EstimatedRangeFormatterMemoryUse);
  return nrf;
}

using FieldType = js::ImmutableTenuredPtr<PropertyName*> JSAtomState::*;

static FieldType GetFieldTypeForNumberPartType(
    mozilla::intl::NumberPartType type) {
  switch (type) {
    case mozilla::intl::NumberPartType::ApproximatelySign:
      return &JSAtomState::approximatelySign;
    case mozilla::intl::NumberPartType::Compact:
      return &JSAtomState::compact;
    case mozilla::intl::NumberPartType::Currency:
      return &JSAtomState::currency;
    case mozilla::intl::NumberPartType::Decimal:
      return &JSAtomState::decimal;
    case mozilla::intl::NumberPartType::ExponentInteger:
      return &JSAtomState::exponentInteger;
    case mozilla::intl::NumberPartType::ExponentMinusSign:
      return &JSAtomState::exponentMinusSign;
    case mozilla::intl::NumberPartType::ExponentSeparator:
      return &JSAtomState::exponentSeparator;
    case mozilla::intl::NumberPartType::Fraction:
      return &JSAtomState::fraction;
    case mozilla::intl::NumberPartType::Group:
      return &JSAtomState::group;
    case mozilla::intl::NumberPartType::Infinity:
      return &JSAtomState::infinity;
    case mozilla::intl::NumberPartType::Integer:
      return &JSAtomState::integer;
    case mozilla::intl::NumberPartType::Literal:
      return &JSAtomState::literal;
    case mozilla::intl::NumberPartType::MinusSign:
      return &JSAtomState::minusSign;
    case mozilla::intl::NumberPartType::Nan:
      return &JSAtomState::nan;
    case mozilla::intl::NumberPartType::Percent:
      return &JSAtomState::percentSign;
    case mozilla::intl::NumberPartType::PlusSign:
      return &JSAtomState::plusSign;
    case mozilla::intl::NumberPartType::Unit:
      return &JSAtomState::unit;
  }

  MOZ_ASSERT_UNREACHABLE(
      "unenumerated, undocumented format field returned by iterator");
  return nullptr;
}

static FieldType GetFieldTypeForNumberPartSource(
    mozilla::intl::NumberPartSource source) {
  switch (source) {
    case mozilla::intl::NumberPartSource::Shared:
      return &JSAtomState::shared;
    case mozilla::intl::NumberPartSource::Start:
      return &JSAtomState::startRange;
    case mozilla::intl::NumberPartSource::End:
      return &JSAtomState::endRange;
  }

  MOZ_CRASH("unexpected number part source");
}

enum class DisplayNumberPartSource : bool { No, Yes };
enum class DisplayLiteralUnit : bool { No, Yes };

/**
 * FormatNumericToParts ( numberFormat, x )
 * FormatNumericRangeToParts ( numberFormat, x, y )
 *
 * Create the part object for FormatNumeric{Range}ToParts.
 */
static PlainObject* CreateNumberPart(JSContext* cx,
                                     const mozilla::intl::NumberPart& part,
                                     Handle<JSString*> value,
                                     DisplayNumberPartSource displaySource,
                                     DisplayLiteralUnit displayLiteralUnit,
                                     FieldType unitType) {
  Rooted<IdValueVector> properties(cx, cx);

  FieldType type = GetFieldTypeForNumberPartType(part.type);
  if (!properties.emplaceBack(NameToId(cx->names().type),
                              StringValue(cx->names().*type))) {
    return nullptr;
  }

  if (!properties.emplaceBack(NameToId(cx->names().value),
                              StringValue(value))) {
    return nullptr;
  }

  if (displaySource == DisplayNumberPartSource::Yes) {
    FieldType source = GetFieldTypeForNumberPartSource(part.source);
    if (!properties.emplaceBack(NameToId(cx->names().source),
                                StringValue(cx->names().*source))) {
      return nullptr;
    }
  }

  if (unitType != nullptr && (type != &JSAtomState::literal ||
                              displayLiteralUnit == DisplayLiteralUnit::Yes)) {
    if (!properties.emplaceBack(NameToId(cx->names().unit),
                                StringValue(cx->names().*unitType))) {
      return nullptr;
    }
  }

  return NewPlainObjectWithUniqueNames(cx, properties);
}

static ArrayObject* FormattedNumberToParts(
    JSContext* cx, Handle<JSString*> string,
    const mozilla::intl::NumberPartVector& parts,
    DisplayNumberPartSource displaySource,
    DisplayLiteralUnit displayLiteralUnit, FieldType unitType) {
  Rooted<ArrayObject*> partsArray(
      cx, NewDenseFullyAllocatedArray(cx, parts.length()));
  if (!partsArray) {
    return nullptr;
  }
  partsArray->ensureDenseInitializedLength(0, parts.length());

  Rooted<JSString*> value(cx);

  size_t index = 0;
  size_t beginIndex = 0;
  for (const auto& part : parts) {
    MOZ_ASSERT(part.endIndex > beginIndex);
    value =
        NewDependentString(cx, string, beginIndex, part.endIndex - beginIndex);
    if (!value) {
      return nullptr;
    }
    beginIndex = part.endIndex;

    auto* obj = CreateNumberPart(cx, part, value, displaySource,
                                 displayLiteralUnit, unitType);
    if (!obj) {
      return nullptr;
    }
    partsArray->initDenseElement(index++, ObjectValue(*obj));
  }
  MOZ_ASSERT(index == parts.length());
  MOZ_ASSERT(beginIndex == string->length(),
             "result array must partition the entire string");

  return partsArray;
}

bool js::intl::FormattedRelativeTimeToParts(
    JSContext* cx, Handle<JSString*> str,
    const mozilla::intl::NumberPartVector& parts,
    RelativeTimeFormatUnit relativeTimeUnit, MutableHandle<JS::Value> result) {
  auto* array =
      FormattedNumberToParts(cx, str, parts, DisplayNumberPartSource::No,
                             DisplayLiteralUnit::No, relativeTimeUnit);
  if (!array) {
    return false;
  }

  result.setObject(*array);
  return true;
}

// Return true if the string starts with "0[bBoOxX]", possibly skipping over
// leading whitespace.
template <typename CharT>
static bool IsNonDecimalNumber(mozilla::Range<const CharT> chars) {
  const CharT* end = chars.begin().get() + chars.length();
  const CharT* start = SkipSpace(chars.begin().get(), end);

  if (end - start >= 2 && start[0] == '0') {
    CharT ch = start[1];
    return ch == 'b' || ch == 'B' || ch == 'o' || ch == 'O' || ch == 'x' ||
           ch == 'X';
  }
  return false;
}

static bool IsNonDecimalNumber(const JSLinearString* str) {
  JS::AutoCheckCannotGC nogc;
  return str->hasLatin1Chars() ? IsNonDecimalNumber(str->latin1Range(nogc))
                               : IsNonDecimalNumber(str->twoByteRange(nogc));
}

/**
 * 15.5.16 ToIntlMathematicalValue ( value )
 *
 * ES2024 Intl draft rev 74ca7099f103d143431b2ea422ae640c6f43e3e6
 */
static bool ToIntlMathematicalValue(JSContext* cx,
                                    MutableHandle<JS::Value> value) {
  // Step 1.
  if (!ToPrimitive(cx, JSTYPE_NUMBER, value)) {
    return false;
  }

  // Step 2.
  if (value.isBigInt()) {
    return true;
  }

  // Step 4.
  if (!value.isString()) {
    // Step 4.a. (Steps 4.b-10 not applicable in our implementation.)
    return ToNumber(cx, value);
  }

  // Step 3.
  auto* str = value.toString()->ensureLinear(cx);
  if (!str) {
    return false;
  }

  // Steps 5-6, 8, and 9.a.
  double number = LinearStringToNumber(str);

  // Step 7.
  if (std::isnan(number)) {
    // Set to NaN if the input can't be parsed as a number.
    value.setNaN();
    return true;
  }

  // Step 9.
  if (number == 0.0 || std::isinf(number)) {
    // Step 9.a. (Reordered)

    // Steps 9.b-e.
    value.setDouble(number);
    return true;
  }

  // Step 10.
  if (IsNonDecimalNumber(str)) {
    // ICU doesn't accept non-decimal numbers, so we have to convert the input
    // into a base-10 string.

    MOZ_ASSERT(!mozilla::IsNegative(number),
               "non-decimal numbers can't be negative");

    if (number < DOUBLE_INTEGRAL_PRECISION_LIMIT) {
      // Fast-path if we can guarantee there was no loss of precision.
      value.setDouble(number);
    } else {
      // For the slow-path convert the string into a BigInt.

      // StringToBigInt can't fail (other than OOM) when StringToNumber already
      // succeeded.
      Rooted<JSString*> rooted(cx, str);
      BigInt* bi;
      JS_TRY_VAR_OR_RETURN_FALSE(cx, bi, StringToBigInt(cx, rooted));
      MOZ_ASSERT(bi);

      value.setBigInt(bi);
    }
  }
  return true;
}

// Return the number part of the input by removing leading and trailing
// whitespace.
template <typename CharT>
static mozilla::Span<const CharT> NumberPart(const CharT* chars,
                                             size_t length) {
  const CharT* start = chars;
  const CharT* end = chars + length;

  start = SkipSpace(start, end);

  // |SkipSpace| only supports forward iteration, so inline the backwards
  // iteration here.
  MOZ_ASSERT(start <= end);
  while (end > start && unicode::IsSpace(end[-1])) {
    end--;
  }

  // The number part is a non-empty, ASCII-only substring.
  MOZ_ASSERT(start < end);
  MOZ_ASSERT(mozilla::IsAscii(mozilla::Span(start, end)));

  return {start, end};
}

static bool NumberPart(JSContext* cx, JSLinearString* str,
                       const JS::AutoCheckCannotGC& nogc,
                       JS::UniqueChars& latin1, std::string_view& result) {
  if (str->hasLatin1Chars()) {
    auto span = NumberPart(
        reinterpret_cast<const char*>(str->latin1Chars(nogc)), str->length());

    result = {span.data(), span.size()};
    return true;
  }

  auto span = NumberPart(str->twoByteChars(nogc), str->length());

  latin1.reset(JS::LossyTwoByteCharsToNewLatin1CharsZ(cx, span).c_str());
  if (!latin1) {
    return false;
  }

  result = {latin1.get(), span.size()};
  return true;
}

class StringNumberChars {
  JS::AutoCheckCannotGC nogc;

  JSLinearString* string_;
  std::string_view view_;

  // Two-byte strings have to be copied into a separate |char| buffer.
  JS::UniqueChars latin1_;

 public:
  explicit StringNumberChars(JSLinearString* string) : string_(string) {}

  bool init(JSContext* cx) {
    return NumberPart(cx, string_, nogc, latin1_, view_);
  }

  operator std::string_view() const { return view_; }
};

static JSLinearString* FormattedResultToString(
    JSContext* cx,
    mozilla::Result<std::u16string_view, mozilla::intl::ICUError>& result) {
  if (result.isErr()) {
    ReportInternalError(cx, result.unwrapErr());
    return nullptr;
  }
  return NewStringCopy<CanGC>(cx, result.unwrap());
}

/**
 * FormatNumeric ( numberFormat, x )
 */
static auto FormatNumeric(JSContext* cx, mozilla::intl::NumberFormat* nf,
                          Handle<JS::BigInt*> value)
    -> decltype(nf->format(int64_t(0))) {
  int64_t num;
  if (BigInt::isInt64(value, &num)) {
    return nf->format(num);
  }

  auto* str = BigInt::toString<CanGC>(cx, value, 10);
  if (!str) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }
  MOZ_RELEASE_ASSERT(str->hasLatin1Chars());

  JS::AutoCheckCannotGC nogc;

  const char* chars = reinterpret_cast<const char*>(str->latin1Chars(nogc));
  return nf->format(std::string_view(chars, str->length()));
}

/**
 * FormatNumeric ( numberFormat, x )
 */
static auto FormatNumeric(JSContext* cx, mozilla::intl::NumberFormat* nf,
                          Handle<JS::Value> value)
    -> decltype(nf->format(0.0)) {
  MOZ_ASSERT(value.isNumeric() || value.isString());

  if (value.isNumber()) {
    return nf->format(value.toNumber());
  }

  if (value.isBigInt()) {
    Rooted<BigInt*> bi(cx, value.toBigInt());
    return FormatNumeric(cx, nf, bi);
  }

  auto* str = value.toString()->ensureLinear(cx);
  if (!str) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  StringNumberChars chars(str);
  if (!chars.init(cx)) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }
  return nf->format(chars);
}

/**
 * FormatNumeric ( numberFormat, x )
 */
static JSString* FormatNumeric(JSContext* cx,
                               Handle<NumberFormatObject*> numberFormat,
                               Handle<JS::Value> value) {
  auto* nf = GetOrCreateNumberFormat(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }

  auto result = FormatNumeric(cx, nf, value);
  return FormattedResultToString(cx, result);
}

/**
 * FormatNumericToParts ( numberFormat, x )
 */
static auto FormatNumericToParts(JSContext* cx, mozilla::intl::NumberFormat* nf,
                                 Handle<JS::Value> value,
                                 mozilla::intl::NumberPartVector& parts)
    -> decltype(nf->formatToParts(0.0, parts)) {
  MOZ_ASSERT(value.isNumeric() || value.isString());

  if (value.isNumber()) {
    return nf->formatToParts(value.toNumber(), parts);
  }

  if (value.isBigInt()) {
    Rooted<BigInt*> bi(cx, value.toBigInt());

    int64_t num;
    if (BigInt::isInt64(bi, &num)) {
      return nf->formatToParts(num, parts);
    }

    auto* str = BigInt::toString<CanGC>(cx, bi, 10);
    if (!str) {
      return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
    }
    MOZ_RELEASE_ASSERT(str->hasLatin1Chars());

    JS::AutoCheckCannotGC nogc;

    const char* chars = reinterpret_cast<const char*>(str->latin1Chars(nogc));
    return nf->formatToParts(std::string_view(chars, str->length()), parts);
  }

  auto* str = value.toString()->ensureLinear(cx);
  if (!str) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  StringNumberChars chars(str);
  if (!chars.init(cx)) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }
  return nf->formatToParts(chars, parts);
}

/**
 * FormatNumericToParts ( numberFormat, x )
 */
static ArrayObject* FormatNumericToParts(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat,
    Handle<JS::Value> value) {
  auto* nf = GetOrCreateNumberFormat(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }

  mozilla::intl::NumberPartVector parts;
  auto result = FormatNumericToParts(cx, nf, value, parts);

  Rooted<JSString*> str(cx, FormattedResultToString(cx, result));
  if (!str) {
    return nullptr;
  }

  return FormattedNumberToParts(cx, str, parts, DisplayNumberPartSource::No,
                                DisplayLiteralUnit::No, nullptr);
}

JSString* js::intl::FormatNumber(JSContext* cx,
                                 Handle<NumberFormatObject*> numberFormat,
                                 double x) {
  auto* nf = GetOrCreateNumberFormat(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }

  auto result = nf->format(x);
  return FormattedResultToString(cx, result);
}

JSString* js::intl::FormatBigInt(JSContext* cx,
                                 Handle<NumberFormatObject*> numberFormat,
                                 Handle<BigInt*> x) {
  auto* nf = GetOrCreateNumberFormat(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }

  auto result = FormatNumeric(cx, nf, x);
  return FormattedResultToString(cx, result);
}

static JSLinearString* ToLinearString(JSContext* cx, Handle<JS::Value> val) {
  // Special case to preserve negative zero.
  if (val.isDouble() && mozilla::IsNegativeZero(val.toDouble())) {
    constexpr std::string_view negativeZero = "-0";
    return NewStringCopy<CanGC>(cx, negativeZero);
  }

  auto* str = ToString(cx, val);
  return str ? str->ensureLinear(cx) : nullptr;
};

static bool EnsureNumericRangeHasNoNaN(JSContext* cx, const char* methodName,
                                       Handle<JS::Value> start,
                                       Handle<JS::Value> end) {
  if (start.isDouble() && std::isnan(start.toDouble())) {
    JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                              JSMSG_NAN_NUMBER_RANGE, "start", "NumberFormat",
                              methodName);
    return false;
  }
  if (end.isDouble() && std::isnan(end.toDouble())) {
    JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                              JSMSG_NAN_NUMBER_RANGE, "end", "NumberFormat",
                              methodName);
    return false;
  }
  return true;
}

static bool ValueRepresentableAsDouble(const Value& val, double* result) {
  if (val.isNumber()) {
    *result = val.toNumber();
    return true;
  }
  if (val.isBigInt()) {
    int64_t i64;
    if (BigInt::isInt64(val.toBigInt(), &i64) &&
        i64 < int64_t(DOUBLE_INTEGRAL_PRECISION_LIMIT) &&
        i64 > -int64_t(DOUBLE_INTEGRAL_PRECISION_LIMIT)) {
      *result = double(i64);
      return true;
    }
  }
  return false;
}

/**
 * FormatNumericRange ( numberFormat, x, y )
 */
static auto FormatNumericRange(JSContext* cx,
                               mozilla::intl::NumberRangeFormat* nf,
                               Handle<JS::Value> start, Handle<JS::Value> end)
    -> decltype(nf->format(0.0, 0.0)) {
  MOZ_ASSERT(start.isNumeric() || start.isString(),
             "start is an Intl mathematical number");
  MOZ_ASSERT(end.isNumeric() || end.isString(),
             "end is an Intl mathematical number");
  MOZ_ASSERT_IF(start.isDouble(), !std::isnan(start.toDouble()));
  MOZ_ASSERT_IF(end.isDouble(), !std::isnan(end.toDouble()));

  double numStart, numEnd;
  if (ValueRepresentableAsDouble(start, &numStart) &&
      ValueRepresentableAsDouble(end, &numEnd)) {
    return nf->format(numStart, numEnd);
  }

  Rooted<JSLinearString*> strStart(cx, ToLinearString(cx, start));
  if (!strStart) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  Rooted<JSLinearString*> strEnd(cx, ToLinearString(cx, end));
  if (!strEnd) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  StringNumberChars charsStart(strStart);
  if (!charsStart.init(cx)) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  StringNumberChars charsEnd(strEnd);
  if (!charsEnd.init(cx)) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  return nf->format(charsStart, charsEnd);
}

/**
 * FormatNumericRange ( numberFormat, x, y )
 */
static JSString* FormatNumericRange(JSContext* cx,
                                    Handle<NumberFormatObject*> numberFormat,
                                    Handle<JS::Value> start,
                                    Handle<JS::Value> end) {
  // PartitionNumberRangePattern, step 1.
  if (!EnsureNumericRangeHasNoNaN(cx, "formatRange", start, end)) {
    return nullptr;
  }

  auto* nf = GetOrCreateNumberRangeFormat(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }

  auto result = FormatNumericRange(cx, nf, start, end);
  return FormattedResultToString(cx, result);
}

/**
 * FormatNumericRangeToParts ( numberFormat, x, y )
 */
static auto FormatNumericRangeToParts(JSContext* cx,
                                      mozilla::intl::NumberRangeFormat* nf,
                                      Handle<JS::Value> start,
                                      Handle<JS::Value> end,
                                      mozilla::intl::NumberPartVector& parts)
    -> decltype(nf->formatToParts(0.0, 0.0, parts)) {
  MOZ_ASSERT(start.isNumeric() || start.isString(),
             "start is an Intl mathematical number");
  MOZ_ASSERT(end.isNumeric() || end.isString(),
             "end is an Intl mathematical number");
  MOZ_ASSERT_IF(start.isDouble(), !std::isnan(start.toDouble()));
  MOZ_ASSERT_IF(end.isDouble(), !std::isnan(end.toDouble()));

  double numStart, numEnd;
  if (ValueRepresentableAsDouble(start, &numStart) &&
      ValueRepresentableAsDouble(end, &numEnd)) {
    return nf->formatToParts(numStart, numEnd, parts);
  }

  Rooted<JSLinearString*> strStart(cx, ToLinearString(cx, start));
  if (!strStart) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  Rooted<JSLinearString*> strEnd(cx, ToLinearString(cx, end));
  if (!strEnd) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  StringNumberChars charsStart(strStart);
  if (!charsStart.init(cx)) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  StringNumberChars charsEnd(strEnd);
  if (!charsEnd.init(cx)) {
    return mozilla::Err(mozilla::intl::ICUError::OutOfMemory);
  }

  return nf->formatToParts(charsStart, charsEnd, parts);
}

/**
 * FormatNumericRangeToParts ( numberFormat, x, y )
 */
static ArrayObject* FormatNumericRangeToParts(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat,
    Handle<JS::Value> start, Handle<JS::Value> end) {
  // PartitionNumberRangePattern, step 1.
  if (!EnsureNumericRangeHasNoNaN(cx, "formatRangeToParts", start, end)) {
    return nullptr;
  }

  auto* nf = GetOrCreateNumberRangeFormat(cx, numberFormat);
  if (!nf) {
    return nullptr;
  }

  mozilla::intl::NumberPartVector parts;
  auto result = FormatNumericRangeToParts(cx, nf, start, end, parts);

  Rooted<JSString*> str(cx, FormattedResultToString(cx, result));
  if (!str) {
    return nullptr;
  }

  return FormattedNumberToParts(cx, str, parts, DisplayNumberPartSource::Yes,
                                DisplayLiteralUnit::No, nullptr);
}

JSLinearString* js::intl::FormatNumber(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat, double x) {
  auto result = numberFormat->format(x);
  return FormattedResultToString(cx, result);
}

JSLinearString* js::intl::FormatNumber(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat,
    std::string_view x) {
  auto result = numberFormat->format(x);
  return FormattedResultToString(cx, result);
}

ArrayObject* js::intl::FormatNumberToParts(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat, double x,
    NumberFormatUnit unit) {
  mozilla::intl::NumberPartVector parts;
  auto result = numberFormat->formatToParts(x, parts);
  Rooted<JSLinearString*> str(cx, FormattedResultToString(cx, result));
  if (!str) {
    return nullptr;
  }
  return FormattedNumberToParts(cx, str, parts, DisplayNumberPartSource::No,
                                DisplayLiteralUnit::Yes, unit);
}

ArrayObject* js::intl::FormatNumberToParts(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat,
    std::string_view x, NumberFormatUnit unit) {
  mozilla::intl::NumberPartVector parts;
  auto result = numberFormat->formatToParts(x, parts);
  Rooted<JSLinearString*> str(cx, FormattedResultToString(cx, result));
  if (!str) {
    return nullptr;
  }
  return FormattedNumberToParts(cx, str, parts, DisplayNumberPartSource::No,
                                DisplayLiteralUnit::Yes, unit);
}

template <class Options>
static bool ResolveNotationOptions(JSContext* cx, const Options& opts,
                                   JS::MutableHandle<IdValueVector> options) {
  auto* notation = NewStringCopy<CanGC>(cx, NotationToString(opts.notation));
  if (!notation) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().notation),
                           StringValue(notation))) {
    return false;
  }

  // compactDisplay is only present when `notation` is "compact".
  if (opts.notation == NumberFormatOptions::Notation::Compact) {
    auto* compactDisplay =
        NewStringCopy<CanGC>(cx, CompactDisplayToString(opts.compactDisplay));
    if (!compactDisplay) {
      return false;
    }
    if (!options.emplaceBack(NameToId(cx->names().compactDisplay),
                             StringValue(compactDisplay))) {
      return false;
    }
  }

  return true;
}

static bool ResolveDigitOptions(JSContext* cx,
                                const NumberFormatDigitOptions& digitOptions,
                                JS::MutableHandle<IdValueVector> options) {
  if (!options.emplaceBack(NameToId(cx->names().minimumIntegerDigits),
                           Int32Value(digitOptions.minimumIntegerDigits))) {
    return false;
  }

  bool hasFractionDigits = digitOptions.minimumFractionDigits >= 0;
  if (hasFractionDigits) {
    MOZ_ASSERT(digitOptions.minimumFractionDigits <=
                   digitOptions.maximumFractionDigits,
               "fraction digits are consistent");

    if (!options.emplaceBack(NameToId(cx->names().minimumFractionDigits),
                             Int32Value(digitOptions.minimumFractionDigits))) {
      return false;
    }

    if (!options.emplaceBack(NameToId(cx->names().maximumFractionDigits),
                             Int32Value(digitOptions.maximumFractionDigits))) {
      return false;
    }
  }

  bool hasSignificantDigits = digitOptions.minimumSignificantDigits > 0;
  if (hasSignificantDigits) {
    MOZ_ASSERT(digitOptions.minimumSignificantDigits <=
                   digitOptions.maximumSignificantDigits,
               "significant digits are consistent");

    if (!options.emplaceBack(
            NameToId(cx->names().minimumSignificantDigits),
            Int32Value(digitOptions.minimumSignificantDigits))) {
      return false;
    }

    if (!options.emplaceBack(
            NameToId(cx->names().maximumSignificantDigits),
            Int32Value(digitOptions.maximumSignificantDigits))) {
      return false;
    }
  }

  return true;
}

static bool ResolveRoundingAndTrailingZeroOptions(
    JSContext* cx, const NumberFormatDigitOptions& digitOptions,
    JS::MutableHandle<IdValueVector> options) {
  if (!options.emplaceBack(NameToId(cx->names().roundingIncrement),
                           Int32Value(digitOptions.roundingIncrement))) {
    return false;
  }

  auto* roundingMode =
      NewStringCopy<CanGC>(cx, RoundingModeToString(digitOptions.roundingMode));
  if (!roundingMode) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().roundingMode),
                           StringValue(roundingMode))) {
    return false;
  }

  auto* roundingPriority = NewStringCopy<CanGC>(
      cx, RoundingPriorityToString(digitOptions.roundingPriority));
  if (!roundingPriority) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().roundingPriority),
                           StringValue(roundingPriority))) {
    return false;
  }

  auto* trailingZeroDisplay = NewStringCopy<CanGC>(
      cx, TrailingZeroDisplayToString(digitOptions.trailingZeroDisplay));
  if (!trailingZeroDisplay) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().trailingZeroDisplay),
                           StringValue(trailingZeroDisplay))) {
    return false;
  }

  return true;
}

/**
 * Intl.PluralRules.prototype.resolvedOptions ( )
 *
 * Resolve plural rules options.
 */
bool js::intl::ResolvePluralRulesOptions(
    JSContext* cx, const PluralRulesOptions& plOptions,
    JS::Handle<ArrayObject*> pluralCategories,
    JS::MutableHandle<IdValueVector> options) {
  if (!ResolveNotationOptions(cx, plOptions, options)) {
    return false;
  }

  if (!ResolveDigitOptions(cx, plOptions.digitOptions, options)) {
    return false;
  }

  if (!options.emplaceBack(NameToId(cx->names().pluralCategories),
                           ObjectValue(*pluralCategories))) {
    return false;
  }

  if (!ResolveRoundingAndTrailingZeroOptions(cx, plOptions.digitOptions,
                                             options)) {
    return false;
  }

  return true;
}

static bool IsNumberFormat(Handle<JS::Value> v) {
  return v.isObject() && v.toObject().is<NumberFormatObject>();
}

/**
 * UnwrapNumberFormat ( dtf )
 */
static bool UnwrapNumberFormat(JSContext* cx, MutableHandle<JS::Value> dtf) {
  // Step 1. (Error handling moved to caller)
  if (!dtf.isObject()) {
    return true;
  }

  auto* obj = &dtf.toObject();
  if (obj->canUnwrapAs<NumberFormatObject>()) {
    return true;
  }

  Rooted<JSObject*> format(cx, obj);
  return UnwrapLegacyIntlFormat(cx, JSProto_NumberFormat, format, dtf);
}

static constexpr uint32_t NumberFormatFunction_NumberFormat = 0;

/**
 * Number Format Functions
 */
static bool NumberFormatFunction(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);

  // Steps 1-2.
  auto* compare = &args.callee().as<JSFunction>();
  auto nfValue = compare->getExtendedSlot(NumberFormatFunction_NumberFormat);
  Rooted<NumberFormatObject*> numberFormat(
      cx, &nfValue.toObject().as<NumberFormatObject>());

  // Step 3.
  Rooted<JS::Value> value(cx, args.get(0));
  if (!ToIntlMathematicalValue(cx, &value)) {
    return false;
  }

  // Step 4.
  auto* result = FormatNumeric(cx, numberFormat, value);
  if (!result) {
    return false;
  }
  args.rval().setString(result);
  return true;
}

/**
 * get Intl.NumberFormat.prototype.format
 */
static bool numberFormat_format(JSContext* cx, const CallArgs& args) {
  Rooted<NumberFormatObject*> numberFormat(
      cx, &args.thisv().toObject().as<NumberFormatObject>());

  // Step 4.
  auto* boundFormat = numberFormat->getBoundFormat();
  if (!boundFormat) {
    Handle<PropertyName*> funName = cx->names().empty_;
    auto* fn =
        NewNativeFunction(cx, NumberFormatFunction, 1, funName,
                          gc::AllocKind::FUNCTION_EXTENDED, GenericObject);
    if (!fn) {
      return false;
    }
    fn->initExtendedSlot(NumberFormatFunction_NumberFormat,
                         ObjectValue(*numberFormat));

    numberFormat->setBoundFormat(fn);
    boundFormat = fn;
  }

  // Step 5.
  args.rval().setObject(*boundFormat);
  return true;
}

/**
 * get Intl.NumberFormat.prototype.format
 */
static bool numberFormat_format(JSContext* cx, unsigned argc, Value* vp) {
  // Steps 1-3.
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!UnwrapNumberFormat(cx, args.mutableThisv())) {
    return false;
  }
  return CallNonGenericMethod<IsNumberFormat, numberFormat_format>(cx, args);
}

/**
 * Intl.NumberFormat.prototype.formatToParts ( value )
 */
static bool numberFormat_formatToParts(JSContext* cx, const CallArgs& args) {
  Rooted<NumberFormatObject*> numberFormat(
      cx, &args.thisv().toObject().as<NumberFormatObject>());

  // Step 3.
  Rooted<JS::Value> value(cx, args.get(0));
  if (!ToIntlMathematicalValue(cx, &value)) {
    return false;
  }

  // Step 4.
  auto* result = FormatNumericToParts(cx, numberFormat, value);
  if (!result) {
    return false;
  }
  args.rval().setObject(*result);
  return true;
}

/**
 * Intl.NumberFormat.prototype.formatToParts ( value )
 */
static bool numberFormat_formatToParts(JSContext* cx, unsigned argc,
                                       Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  return CallNonGenericMethod<IsNumberFormat, numberFormat_formatToParts>(cx,
                                                                          args);
}

/**
 * Intl.NumberFormat.prototype.formatRange ( start, end )
 */
static bool numberFormat_formatRange(JSContext* cx, const CallArgs& args) {
  Rooted<NumberFormatObject*> numberFormat(
      cx, &args.thisv().toObject().as<NumberFormatObject>());

  // Step 3.
  if (!args.hasDefined(0) || !args.hasDefined(1)) {
    JS_ReportErrorNumberASCII(
        cx, GetErrorMessage, nullptr, JSMSG_UNDEFINED_NUMBER,
        !args.hasDefined(0) ? "start" : "end", "NumberFormat", "formatRange");
    return false;
  }

  // Step 4.
  Rooted<JS::Value> start(cx, args[0]);
  if (!ToIntlMathematicalValue(cx, &start)) {
    return false;
  }

  // Step 5.
  Rooted<JS::Value> end(cx, args[1]);
  if (!ToIntlMathematicalValue(cx, &end)) {
    return false;
  }

  // Step 6.
  auto* result = FormatNumericRange(cx, numberFormat, start, end);
  if (!result) {
    return false;
  }
  args.rval().setString(result);
  return true;
}

/**
 * Intl.NumberFormat.prototype.formatRange ( start, end )
 */
static bool numberFormat_formatRange(JSContext* cx, unsigned argc, Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  return CallNonGenericMethod<IsNumberFormat, numberFormat_formatRange>(cx,
                                                                        args);
}

/**
 * Intl.NumberFormat.prototype.formatRangeToParts ( start, end )
 */
static bool numberFormat_formatRangeToParts(JSContext* cx,
                                            const CallArgs& args) {
  Rooted<NumberFormatObject*> numberFormat(
      cx, &args.thisv().toObject().as<NumberFormatObject>());

  // Step 3.
  if (!args.hasDefined(0) || !args.hasDefined(1)) {
    JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                              JSMSG_UNDEFINED_NUMBER,
                              !args.hasDefined(0) ? "start" : "end",
                              "NumberFormat", "formatRangeToParts");
    return false;
  }

  // Step 4.
  Rooted<JS::Value> start(cx, args[0]);
  if (!ToIntlMathematicalValue(cx, &start)) {
    return false;
  }

  // Step 5.
  Rooted<JS::Value> end(cx, args[1]);
  if (!ToIntlMathematicalValue(cx, &end)) {
    return false;
  }

  // Step 6.
  auto* result = FormatNumericRangeToParts(cx, numberFormat, start, end);
  if (!result) {
    return false;
  }
  args.rval().setObject(*result);
  return true;
}

/**
 * Intl.NumberFormat.prototype.formatRangeToParts ( start, end )
 */
static bool numberFormat_formatRangeToParts(JSContext* cx, unsigned argc,
                                            Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  return CallNonGenericMethod<IsNumberFormat, numberFormat_formatRangeToParts>(
      cx, args);
}

/**
 * Intl.NumberFormat.prototype.resolvedOptions ( )
 */
static bool numberFormat_resolvedOptions(JSContext* cx, const CallArgs& args) {
  Rooted<NumberFormatObject*> numberFormat(
      cx, &args.thisv().toObject().as<NumberFormatObject>());

  if (!ResolveLocale(cx, numberFormat)) {
    return false;
  }
  auto nfOptions = *numberFormat->getOptions();

  // Step 4.
  Rooted<IdValueVector> options(cx, cx);

  // Step 5.
  if (!options.emplaceBack(NameToId(cx->names().locale),
                           StringValue(numberFormat->getLocale()))) {
    return false;
  }

  if (!options.emplaceBack(NameToId(cx->names().numberingSystem),
                           StringValue(numberFormat->getNumberingSystem()))) {
    return false;
  }

  auto* style = NewStringCopy<CanGC>(
      cx, NumberFormatStyleToString(nfOptions.unitOptions.style));
  if (!style) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().style), StringValue(style))) {
    return false;
  }

#ifndef USING_ENUM
  using enum NumberFormatUnitOptions::Style;
#else
  USING_ENUM(NumberFormatUnitOptions::Style, Decimal, Percent, Currency, Unit);
#endif
  switch (nfOptions.unitOptions.style) {
    case Decimal:
    case Percent:
      break;

    case Currency: {
      // currency, currencyDisplay, and currencySign are only present for
      // currency formatters.

      const auto& code = nfOptions.unitOptions.currency.code;
      auto* currency = NewStringCopyN<CanGC>(cx, code, std::size(code));
      if (!currency) {
        return false;
      }
      if (!options.emplaceBack(NameToId(cx->names().currency),
                               StringValue(currency))) {
        return false;
      }

      auto* currencyDisplay = NewStringCopy<CanGC>(
          cx, CurrencyDisplayToString(nfOptions.unitOptions.currencyDisplay));
      if (!currencyDisplay) {
        return false;
      }
      if (!options.emplaceBack(NameToId(cx->names().currencyDisplay),
                               StringValue(currencyDisplay))) {
        return false;
      }

      auto* currencySign = NewStringCopy<CanGC>(
          cx, CurrencySignToString(nfOptions.unitOptions.currencySign));
      if (!currencySign) {
        return false;
      }
      if (!options.emplaceBack(NameToId(cx->names().currencySign),
                               StringValue(currencySign))) {
        return false;
      }

      break;
    }

    case Unit: {
      // unit and unitDisplay are only present for unit formatters.

      auto name = std::string_view{nfOptions.unitOptions.unit.name};
      auto* unit = NewStringCopy<CanGC>(cx, name);
      if (!unit) {
        return false;
      }
      if (!options.emplaceBack(NameToId(cx->names().unit), StringValue(unit))) {
        return false;
      }

      auto* unitDisplay = NewStringCopy<CanGC>(
          cx, UnitDisplayToString(nfOptions.unitOptions.unitDisplay));
      if (!unitDisplay) {
        return false;
      }
      if (!options.emplaceBack(NameToId(cx->names().unitDisplay),
                               StringValue(unitDisplay))) {
        return false;
      }

      break;
    }
  }

  if (!ResolveDigitOptions(cx, nfOptions.digitOptions, &options)) {
    return false;
  }

  if (nfOptions.useGrouping != NumberFormatOptions::UseGrouping::Never) {
    auto* useGrouping =
        NewStringCopy<CanGC>(cx, UseGroupingToString(nfOptions.useGrouping));
    if (!useGrouping) {
      return false;
    }
    if (!options.emplaceBack(NameToId(cx->names().useGrouping),
                             StringValue(useGrouping))) {
      return false;
    }
  } else {
    if (!options.emplaceBack(NameToId(cx->names().useGrouping),
                             BooleanValue(false))) {
      return false;
    }
  }

  if (!ResolveNotationOptions(cx, nfOptions, &options)) {
    return false;
  }

  auto* signDisplay =
      NewStringCopy<CanGC>(cx, SignDisplayToString(nfOptions.signDisplay));
  if (!signDisplay) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().signDisplay),
                           StringValue(signDisplay))) {
    return false;
  }

  if (!ResolveRoundingAndTrailingZeroOptions(cx, nfOptions.digitOptions,
                                             &options)) {
    return false;
  }

  // Step 6.
  auto* result = NewPlainObjectWithUniqueNames(cx, options);
  if (!result) {
    return false;
  }
  args.rval().setObject(*result);
  return true;
}

/**
 * Intl.NumberFormat.prototype.resolvedOptions ( )
 */
static bool numberFormat_resolvedOptions(JSContext* cx, unsigned argc,
                                         Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!UnwrapNumberFormat(cx, args.mutableThisv())) {
    return false;
  }
  return CallNonGenericMethod<IsNumberFormat, numberFormat_resolvedOptions>(
      cx, args);
}

/**
 * Intl.NumberFormat.supportedLocalesOf ( locales [ , options ] )
 */
static bool numberFormat_supportedLocalesOf(JSContext* cx, unsigned argc,
                                            Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);

  // Steps 1-3.
  auto* array = SupportedLocalesOf(cx, AvailableLocaleKind::NumberFormat,
                                   args.get(0), args.get(1));
  if (!array) {
    return false;
  }
  args.rval().setObject(*array);
  return true;
}
