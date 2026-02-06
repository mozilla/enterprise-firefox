/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef builtin_intl_NumberFormat_h
#define builtin_intl_NumberFormat_h

#include <stddef.h>
#include <stdint.h>
#include <string_view>

#include "ds/IdValuePair.h"
#include "js/Class.h"
#include "vm/NativeObject.h"
#include "vm/StringType.h"

namespace mozilla::intl {
class NumberFormat;
class NumberRangeFormat;
struct PluralRulesOptions;
}  // namespace mozilla::intl

namespace js {

class ArrayObject;

namespace intl {

struct NumberFormatDigitOptions {
  // integer ∈ (1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500,
  // 5000)
  int16_t roundingIncrement = 0;

  int8_t minimumIntegerDigits = 0;  // integer ∈ [1, 21]

  // optional, mutually exclusive with the significant-digits option
  int8_t minimumFractionDigits = 0;  // integer ∈ [0, 100]
  int8_t maximumFractionDigits = 0;  // integer ∈ [0, 100]

  // optional, mutually exclusive with the fraction-digits option
  int8_t minimumSignificantDigits = 0;  // integer ∈ [1, 21]
  int8_t maximumSignificantDigits = 0;  // integer ∈ [1, 21]

  enum class RoundingMode : int8_t {
    Ceil,
    Floor,
    Expand,
    Trunc,
    HalfCeil,
    HalfFloor,
    HalfExpand,
    HalfTrunc,
    HalfEven
  };
  RoundingMode roundingMode = RoundingMode::HalfExpand;

  enum class RoundingPriority : int8_t { Auto, MorePrecision, LessPrecision };
  RoundingPriority roundingPriority = RoundingPriority::Auto;

  enum class TrailingZeroDisplay : int8_t { Auto, StripIfInteger };
  TrailingZeroDisplay trailingZeroDisplay = TrailingZeroDisplay::Auto;
};

struct NumberFormatUnitOptions {
  enum class Style : int8_t { Decimal, Percent, Currency, Unit };
  Style style = Style::Decimal;

  enum class CurrencyDisplay : int8_t { Symbol, NarrowSymbol, Code, Name };
  CurrencyDisplay currencyDisplay = CurrencyDisplay::Symbol;

  enum class CurrencySign : int8_t { Standard, Accounting };
  CurrencySign currencySign = CurrencySign::Standard;

  enum class UnitDisplay : int8_t { Short, Narrow, Long };
  UnitDisplay unitDisplay = UnitDisplay::Short;

  struct Currency {
    char code[3] = {};
  };
  Currency currency{};

  struct Unit {
    char name[40] = {};
  };
  Unit unit{};
};

struct NumberFormatOptions {
  NumberFormatDigitOptions digitOptions{};

  NumberFormatUnitOptions unitOptions{};

  enum class Notation : int8_t { Standard, Scientific, Engineering, Compact };
  Notation notation = Notation::Standard;

  enum class CompactDisplay : int8_t { Short, Long };
  CompactDisplay compactDisplay = CompactDisplay::Short;

  enum class UseGrouping : int8_t { Auto, Min2, Always, Never };
  UseGrouping useGrouping = UseGrouping::Auto;

  enum class SignDisplay : int8_t { Auto, Never, Always, ExceptZero, Negative };
  SignDisplay signDisplay = SignDisplay::Auto;
};

}  // namespace intl

class NumberFormatObject : public NativeObject {
 public:
  static const JSClass class_;
  static const JSClass& protoClass_;

  static constexpr uint32_t LOCALE_SLOT = 0;
  static constexpr uint32_t NUMBERING_SYSTEM_SLOT = 1;
  static constexpr uint32_t OPTIONS_SLOT = 2;
  static constexpr uint32_t UNUMBER_FORMATTER_SLOT = 3;
  static constexpr uint32_t UNUMBER_RANGE_FORMATTER_SLOT = 4;
  static constexpr uint32_t BOUND_FORMAT_SLOT = 5;
  static constexpr uint32_t SLOT_COUNT = 6;

  // Estimated memory use for UNumberFormatter and UFormattedNumber
  // (see IcuMemoryUsage).
  static constexpr size_t EstimatedMemoryUse = 972;

  // Estimated memory use for UNumberRangeFormatter and UFormattedNumberRange
  // (see IcuMemoryUsage).
  static constexpr size_t EstimatedRangeFormatterMemoryUse = 19894;

  bool isLocaleResolved() const { return getFixedSlot(LOCALE_SLOT).isString(); }

  JSObject* getRequestedLocales() const {
    const auto& slot = getFixedSlot(LOCALE_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return &slot.toObject();
  }

  void setRequestedLocales(JSObject* requestedLocales) {
    setFixedSlot(LOCALE_SLOT, JS::ObjectValue(*requestedLocales));
  }

  JSLinearString* getLocale() const {
    const auto& slot = getFixedSlot(LOCALE_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return &slot.toString()->asLinear();
  }

  void setLocale(JSLinearString* locale) {
    setFixedSlot(LOCALE_SLOT, JS::StringValue(locale));
  }

  JSLinearString* getNumberingSystem() const {
    const auto& slot = getFixedSlot(NUMBERING_SYSTEM_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return &slot.toString()->asLinear();
  }

  void setNumberingSystem(JSLinearString* numberingSystem) {
    setFixedSlot(NUMBERING_SYSTEM_SLOT, JS::StringValue(numberingSystem));
  }

  intl::NumberFormatOptions* getOptions() const {
    const auto& slot = getFixedSlot(OPTIONS_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return static_cast<intl::NumberFormatOptions*>(slot.toPrivate());
  }

  void setOptions(intl::NumberFormatOptions* options) {
    setFixedSlot(OPTIONS_SLOT, JS::PrivateValue(options));
  }

  mozilla::intl::NumberFormat* getNumberFormatter() const {
    const auto& slot = getFixedSlot(UNUMBER_FORMATTER_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return static_cast<mozilla::intl::NumberFormat*>(slot.toPrivate());
  }

  void setNumberFormatter(mozilla::intl::NumberFormat* formatter) {
    setFixedSlot(UNUMBER_FORMATTER_SLOT, PrivateValue(formatter));
  }

  mozilla::intl::NumberRangeFormat* getNumberRangeFormatter() const {
    const auto& slot = getFixedSlot(UNUMBER_RANGE_FORMATTER_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return static_cast<mozilla::intl::NumberRangeFormat*>(slot.toPrivate());
  }

  void setNumberRangeFormatter(mozilla::intl::NumberRangeFormat* formatter) {
    setFixedSlot(UNUMBER_RANGE_FORMATTER_SLOT, PrivateValue(formatter));
  }

  JSObject* getBoundFormat() const {
    const auto& slot = getFixedSlot(BOUND_FORMAT_SLOT);
    if (slot.isUndefined()) {
      return nullptr;
    }
    return &slot.toObject();
  }

  void setBoundFormat(JSObject* boundFormat) {
    setFixedSlot(BOUND_FORMAT_SLOT, JS::ObjectValue(*boundFormat));
  }

 private:
  static const JSClassOps classOps_;
  static const ClassSpec classSpec_;

  static void finalize(JS::GCContext* gcx, JSObject* obj);
};

namespace intl {
struct PluralRulesOptions;

/**
 * SetNumberFormatDigitOptions ( intlObj, options, mnfdDefault, mxfdDefault,
 * notation )
 */
bool SetNumberFormatDigitOptions(JSContext* cx, NumberFormatDigitOptions& obj,
                                 JS::Handle<JSObject*> options,
                                 int32_t mnfdDefault, int32_t mxfdDefault,
                                 NumberFormatOptions::Notation notation);

/**
 * Set the plural rules options.
 */
void SetPluralRulesOptions(const PluralRulesOptions& plOptions,
                           mozilla::intl::PluralRulesOptions& options);

/**
 * Resolve plural rules options.
 */
bool ResolvePluralRulesOptions(JSContext* cx,
                               const PluralRulesOptions& plOptions,
                               JS::Handle<ArrayObject*> pluralCategories,
                               JS::MutableHandle<IdValueVector> options);

/**
 * Returns a new instance of the standard built-in NumberFormat constructor.
 */
[[nodiscard]] extern NumberFormatObject* CreateNumberFormat(
    JSContext* cx, JS::Handle<JS::Value> locales,
    JS::Handle<JS::Value> options);

/**
 * Returns a possibly cached instance of the standard built-in NumberFormat
 * constructor.
 */
[[nodiscard]] extern NumberFormatObject* GetOrCreateNumberFormat(
    JSContext* cx, JS::Handle<JS::Value> locales,
    JS::Handle<JS::Value> options);

/**
 * Returns a string representing the number x according to the effective locale
 * and the formatting options of the given NumberFormat.
 */
[[nodiscard]] extern JSString* FormatNumber(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat, double x);

/**
 * Returns a string representing the BigInt x according to the effective locale
 * and the formatting options of the given NumberFormat.
 */
[[nodiscard]] extern JSString* FormatBigInt(
    JSContext* cx, Handle<NumberFormatObject*> numberFormat, Handle<BigInt*> x);

using NumberFormatUnit = js::ImmutableTenuredPtr<PropertyName*> JSAtomState::*;

[[nodiscard]] extern JSLinearString* FormatNumber(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat, double x);

[[nodiscard]] extern JSLinearString* FormatNumber(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat,
    std::string_view x);

[[nodiscard]] extern ArrayObject* FormatNumberToParts(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat, double x,
    NumberFormatUnit unit = nullptr);

[[nodiscard]] extern ArrayObject* FormatNumberToParts(
    JSContext* cx, mozilla::intl::NumberFormat* numberFormat,
    std::string_view x, NumberFormatUnit unit = nullptr);

}  // namespace intl

}  // namespace js

#endif /* builtin_intl_NumberFormat_h */
