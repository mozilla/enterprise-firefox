/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Intl.RelativeTimeFormat implementation. */

#include "builtin/intl/RelativeTimeFormat.h"

#include "mozilla/Assertions.h"
#include "mozilla/intl/RelativeTimeFormat.h"

#include "builtin/intl/CommonFunctions.h"
#include "builtin/intl/FormatBuffer.h"
#include "builtin/intl/LanguageTag.h"
#include "builtin/intl/LocaleNegotiation.h"
#include "builtin/intl/ParameterNegotiation.h"
#include "builtin/intl/UsingEnum.h"
#include "gc/GCContext.h"
#include "js/friend/ErrorMessages.h"  // js::GetErrorMessage, JSMSG_*
#include "js/Printer.h"
#include "js/PropertySpec.h"
#include "vm/GlobalObject.h"
#include "vm/JSContext.h"
#include "vm/PlainObject.h"
#include "vm/StringType.h"

#include "vm/NativeObject-inl.h"

using namespace js;
using namespace js::intl;

/**************** RelativeTimeFormat *****************/

const JSClassOps RelativeTimeFormatObject::classOps_ = {
    nullptr,                             // addProperty
    nullptr,                             // delProperty
    nullptr,                             // enumerate
    nullptr,                             // newEnumerate
    nullptr,                             // resolve
    nullptr,                             // mayResolve
    RelativeTimeFormatObject::finalize,  // finalize
    nullptr,                             // call
    nullptr,                             // construct
    nullptr,                             // trace
};

const JSClass RelativeTimeFormatObject::class_ = {
    "Intl.RelativeTimeFormat",
    JSCLASS_HAS_RESERVED_SLOTS(RelativeTimeFormatObject::SLOT_COUNT) |
        JSCLASS_HAS_CACHED_PROTO(JSProto_RelativeTimeFormat) |
        JSCLASS_BACKGROUND_FINALIZE,
    &RelativeTimeFormatObject::classOps_,
    &RelativeTimeFormatObject::classSpec_,
};

const JSClass& RelativeTimeFormatObject::protoClass_ = PlainObject::class_;

static bool relativeTimeFormat_supportedLocalesOf(JSContext* cx, unsigned argc,
                                                  Value* vp);

static bool relativeTimeFormat_format(JSContext* cx, unsigned argc, Value* vp);

static bool relativeTimeFormat_formatToParts(JSContext* cx, unsigned argc,
                                             Value* vp);

static bool relativeTimeFormat_resolvedOptions(JSContext* cx, unsigned argc,
                                               Value* vp);

static bool relativeTimeFormat_toSource(JSContext* cx, unsigned argc,
                                        Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setString(cx->names().RelativeTimeFormat);
  return true;
}

static const JSFunctionSpec relativeTimeFormat_static_methods[] = {
    JS_FN("supportedLocalesOf", relativeTimeFormat_supportedLocalesOf, 1, 0),
    JS_FS_END,
};

static const JSFunctionSpec relativeTimeFormat_methods[] = {
    JS_FN("resolvedOptions", relativeTimeFormat_resolvedOptions, 0, 0),
    JS_FN("format", relativeTimeFormat_format, 2, 0),
    JS_FN("formatToParts", relativeTimeFormat_formatToParts, 2, 0),
    JS_FN("toSource", relativeTimeFormat_toSource, 0, 0),
    JS_FS_END,
};

static const JSPropertySpec relativeTimeFormat_properties[] = {
    JS_STRING_SYM_PS(toStringTag, "Intl.RelativeTimeFormat", JSPROP_READONLY),
    JS_PS_END,
};

static bool RelativeTimeFormat(JSContext* cx, unsigned argc, Value* vp);

const ClassSpec RelativeTimeFormatObject::classSpec_ = {
    GenericCreateConstructor<RelativeTimeFormat, 0, gc::AllocKind::FUNCTION>,
    GenericCreatePrototype<RelativeTimeFormatObject>,
    relativeTimeFormat_static_methods,
    nullptr,
    relativeTimeFormat_methods,
    relativeTimeFormat_properties,
    nullptr,
    ClassSpec::DontDefineConstructor,
};

static constexpr std::string_view StyleToString(
    RelativeTimeFormatOptions::Style style) {
#ifndef USING_ENUM
  using enum RelativeTimeFormatOptions::Style;
#else
  USING_ENUM(RelativeTimeFormatOptions::Style, Long, Short, Narrow);
#endif
  switch (style) {
    case Long:
      return "long";
    case Short:
      return "short";
    case Narrow:
      return "narrow";
  }
  MOZ_CRASH("invalid relative time format style");
}

static constexpr std::string_view NumericToString(
    RelativeTimeFormatOptions::Numeric numeric) {
#ifndef USING_ENUM
  using enum RelativeTimeFormatOptions::Numeric;
#else
  USING_ENUM(RelativeTimeFormatOptions::Numeric, Always, Auto);
#endif
  switch (numeric) {
    case Always:
      return "always";
    case Auto:
      return "auto";
  }
  MOZ_CRASH("invalid relative time format numeric");
}

/**
 * Intl.RelativeTimeFormat ( [ locales [ , options ] ] )
 */
static bool RelativeTimeFormat(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);

  // Step 1.
  if (!ThrowIfNotConstructing(cx, args, "Intl.RelativeTimeFormat")) {
    return false;
  }

  // Step 2 (Inlined 9.1.14, OrdinaryCreateFromConstructor).
  Rooted<JSObject*> proto(cx);
  if (!GetPrototypeFromBuiltinConstructor(cx, args, JSProto_RelativeTimeFormat,
                                          &proto)) {
    return false;
  }

  Rooted<RelativeTimeFormatObject*> relativeTimeFormat(cx);
  relativeTimeFormat =
      NewObjectWithClassProto<RelativeTimeFormatObject>(cx, proto);
  if (!relativeTimeFormat) {
    return false;
  }

  // Step 3. (Inlined ResolveOptions)

  // ResolveOptions, step 1.
  Rooted<LocalesList> requestedLocales(cx, cx);
  if (!CanonicalizeLocaleList(cx, args.get(0), &requestedLocales)) {
    return false;
  }

  Rooted<ArrayObject*> requestedLocalesArray(
      cx, LocalesListToArray(cx, requestedLocales));
  if (!requestedLocalesArray) {
    return false;
  }
  relativeTimeFormat->setRequestedLocales(requestedLocalesArray);

  auto rtfOptions = cx->make_unique<RelativeTimeFormatOptions>();
  if (!rtfOptions) {
    return false;
  }

  if (args.hasDefined(1)) {
    // ResolveOptions, steps 2-3.
    Rooted<JSObject*> options(cx, JS::ToObject(cx, args[1]));
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
      relativeTimeFormat->setNumberingSystem(numberingSystem);
    }

    // ResolveOptions, step 7. (Not applicable)

    // ResolveOptions, step 8. (Performed in ResolveRelativeTimeFormat)

    // ResolveOptions, step 9. (Return)

    // Step 4. (Not applicable when ResolveOptions is inlined.)

    // Steps 5-9. (Performed in ResolveLocale)

    // Steps 10-11.
    static constexpr auto styles =
        MapOptions<StyleToString>(RelativeTimeFormatOptions::Style::Long,
                                  RelativeTimeFormatOptions::Style::Short,
                                  RelativeTimeFormatOptions::Style::Narrow);
    if (!GetStringOption(cx, options, cx->names().style, styles,
                         RelativeTimeFormatOptions::Style::Long,
                         &rtfOptions->style)) {
      return false;
    }

    // Steps 12-13.
    static constexpr auto numerics =
        MapOptions<NumericToString>(RelativeTimeFormatOptions::Numeric::Always,
                                    RelativeTimeFormatOptions::Numeric::Auto);
    if (!GetStringOption(cx, options, cx->names().numeric, numerics,
                         RelativeTimeFormatOptions::Numeric::Always,
                         &rtfOptions->numeric)) {
      return false;
    }
  }
  relativeTimeFormat->setOptions(rtfOptions.release());
  AddCellMemory(relativeTimeFormat, sizeof(RelativeTimeFormatOptions),
                MemoryUse::IntlOptions);

  // Steps 14-17. (Not applicable in our implementation.)

  // Step 18.
  args.rval().setObject(*relativeTimeFormat);
  return true;
}

void js::RelativeTimeFormatObject::finalize(JS::GCContext* gcx, JSObject* obj) {
  auto* rtf = &obj->as<RelativeTimeFormatObject>();

  if (auto* options = rtf->getOptions()) {
    gcx->delete_(obj, options, MemoryUse::IntlOptions);
  }

  if (auto* formatter = rtf->getRelativeTimeFormatter()) {
    RemoveICUCellMemory(gcx, obj, RelativeTimeFormatObject::EstimatedMemoryUse);

    // This was allocated using `new` in mozilla::intl::RelativeTimeFormat,
    // so we delete here.
    delete formatter;
  }
}

/**
 * Resolve the actual locale to finish initialization of the RelativeTimeFormat.
 */
static bool ResolveLocale(
    JSContext* cx, Handle<RelativeTimeFormatObject*> relativeTimeFormat) {
  // Return if the locale was already resolved.
  if (relativeTimeFormat->isLocaleResolved()) {
    return true;
  }

  Rooted<ArrayObject*> requestedLocales(
      cx, &relativeTimeFormat->getRequestedLocales()->as<ArrayObject>());

  // %Intl.RelativeTimeFormat%.[[RelevantExtensionKeys]] is « "nu" ».
  mozilla::EnumSet<UnicodeExtensionKey> relevantExtensionKeys{
      UnicodeExtensionKey::NumberingSystem,
  };

  // Initialize locale options from constructor arguments.
  Rooted<LocaleOptions> localeOptions(cx);
  if (auto* nu = relativeTimeFormat->getNumberingSystem()) {
    localeOptions.setUnicodeExtension(UnicodeExtensionKey::NumberingSystem, nu);
  }

  // Use the default locale data.
  auto localeData = LocaleData::Default;

  // Resolve the actual locale.
  Rooted<ResolvedLocale> resolved(cx);
  if (!ResolveLocale(cx, AvailableLocaleKind::RelativeTimeFormat,
                     requestedLocales, localeOptions, relevantExtensionKeys,
                     localeData, &resolved)) {
    return false;
  }

  // Finish initialization by setting the actual locale and numbering system.
  auto* locale = resolved.toLocale(cx);
  if (!locale) {
    return false;
  }
  relativeTimeFormat->setLocale(locale);

  auto nu = resolved.extension(UnicodeExtensionKey::NumberingSystem);
  MOZ_ASSERT(nu, "resolved numbering system is non-null");
  relativeTimeFormat->setNumberingSystem(nu);

  MOZ_ASSERT(relativeTimeFormat->isLocaleResolved(),
             "locale successfully resolved");
  return true;
}

static auto ToRelativeTimeFormatOptionsStyle(
    RelativeTimeFormatOptions::Style style) {
#ifndef USING_ENUM
  using enum mozilla::intl::RelativeTimeFormatOptions::Style;
#else
  USING_ENUM(mozilla::intl::RelativeTimeFormatOptions::Style, Long, Short,
             Narrow);
#endif
  switch (style) {
    case RelativeTimeFormatOptions::Style::Long:
      return Long;
    case RelativeTimeFormatOptions::Style::Short:
      return Short;
    case RelativeTimeFormatOptions::Style::Narrow:
      return Narrow;
  }
  MOZ_CRASH("invalid relative time format style");
}

static auto ToRelativeTimeFormatOptionsNumeric(
    RelativeTimeFormatOptions::Numeric numeric) {
#ifndef USING_ENUM
  using enum mozilla::intl::RelativeTimeFormatOptions::Numeric;
#else
  USING_ENUM(mozilla::intl::RelativeTimeFormatOptions::Numeric, Always, Auto);
#endif
  switch (numeric) {
    case RelativeTimeFormatOptions::Numeric::Always:
      return Always;
    case RelativeTimeFormatOptions::Numeric::Auto:
      return Auto;
  }
  MOZ_CRASH("invalid relative time format numeric");
}

/**
 * Returns a new URelativeDateTimeFormatter with the locale and options of the
 * given RelativeTimeFormatObject.
 */
static mozilla::intl::RelativeTimeFormat* NewRelativeTimeFormatter(
    JSContext* cx, Handle<RelativeTimeFormatObject*> relativeTimeFormat) {
  if (!ResolveLocale(cx, relativeTimeFormat)) {
    return nullptr;
  }
  auto rtfOptions = *relativeTimeFormat->getOptions();

  // ICU expects numberingSystem as a Unicode locale extensions on locale.

  JS::RootedVector<UnicodeExtensionKeyword> keywords(cx);
  if (!keywords.emplaceBack("nu", relativeTimeFormat->getNumberingSystem())) {
    return nullptr;
  }

  Rooted<JSLinearString*> localeStr(cx, relativeTimeFormat->getLocale());
  auto locale = FormatLocale(cx, localeStr, keywords);
  if (!locale) {
    return nullptr;
  }

  mozilla::intl::RelativeTimeFormatOptions options = {
      .style = ToRelativeTimeFormatOptionsStyle(rtfOptions.style),
      .numeric = ToRelativeTimeFormatOptionsNumeric(rtfOptions.numeric),
  };

  auto result =
      mozilla::intl::RelativeTimeFormat::TryCreate(locale.get(), options);
  if (result.isErr()) {
    ReportInternalError(cx, result.unwrapErr());
    return nullptr;
  }
  return result.unwrap().release();
}

static mozilla::intl::RelativeTimeFormat* GetOrCreateRelativeTimeFormat(
    JSContext* cx, Handle<RelativeTimeFormatObject*> relativeTimeFormat) {
  // Obtain a cached RelativeDateTimeFormatter object.
  auto* rtf = relativeTimeFormat->getRelativeTimeFormatter();
  if (rtf) {
    return rtf;
  }

  rtf = NewRelativeTimeFormatter(cx, relativeTimeFormat);
  if (!rtf) {
    return nullptr;
  }
  relativeTimeFormat->setRelativeTimeFormatter(rtf);

  AddICUCellMemory(relativeTimeFormat,
                   RelativeTimeFormatObject::EstimatedMemoryUse);
  return rtf;
}

/**
 * SingularRelativeTimeUnit ( unit )
 */
static bool SingularRelativeTimeUnit(
    JSContext* cx, Handle<JSString*> string,
    mozilla::intl::RelativeTimeFormat::FormatUnit* result) {
  using FormatUnit = mozilla::intl::RelativeTimeFormat::FormatUnit;

  auto* unit = string->ensureLinear(cx);
  if (!unit) {
    return false;
  }

  // Steps 1-10.
  if (StringEqualsLiteral(unit, "second") ||
      StringEqualsLiteral(unit, "seconds")) {
    *result = FormatUnit::Second;
  } else if (StringEqualsLiteral(unit, "minute") ||
             StringEqualsLiteral(unit, "minutes")) {
    *result = FormatUnit::Minute;
  } else if (StringEqualsLiteral(unit, "hour") ||
             StringEqualsLiteral(unit, "hours")) {
    *result = FormatUnit::Hour;
  } else if (StringEqualsLiteral(unit, "day") ||
             StringEqualsLiteral(unit, "days")) {
    *result = FormatUnit::Day;
  } else if (StringEqualsLiteral(unit, "week") ||
             StringEqualsLiteral(unit, "weeks")) {
    *result = FormatUnit::Week;
  } else if (StringEqualsLiteral(unit, "month") ||
             StringEqualsLiteral(unit, "months")) {
    *result = FormatUnit::Month;
  } else if (StringEqualsLiteral(unit, "quarter") ||
             StringEqualsLiteral(unit, "quarters")) {
    *result = FormatUnit::Quarter;
  } else if (StringEqualsLiteral(unit, "year") ||
             StringEqualsLiteral(unit, "years")) {
    *result = FormatUnit::Year;
  } else {
    if (auto unitChars = QuoteString(cx, unit, '"')) {
      JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                                JSMSG_INVALID_OPTION_VALUE, "unit",
                                unitChars.get());
    }
    return false;
  }
  return true;
}

static RelativeTimeFormatUnit ToRelativeTimeFormatUnit(
    mozilla::intl::RelativeTimeFormat::FormatUnit unit) {
#ifndef USING_ENUM
  using enum mozilla::intl::RelativeTimeFormat::FormatUnit;
#else
  USING_ENUM(mozilla::intl::RelativeTimeFormat::FormatUnit, Second, Minute,
             Hour, Day, Week, Month, Quarter, Year);
#endif

  switch (unit) {
    case Second:
      return &JSAtomState::second;
    case Minute:
      return &JSAtomState::minute;
    case Hour:
      return &JSAtomState::hour;
    case Day:
      return &JSAtomState::day;
    case Week:
      return &JSAtomState::week;
    case Month:
      return &JSAtomState::month;
    case Quarter:
      return &JSAtomState::quarter;
    case Year:
      return &JSAtomState::year;
  }
  MOZ_CRASH("invalid format unit");
}

/**
 * FormatRelativeTime ( relativeTimeFormat, value, unit )
 * FormatRelativeTimeToParts ( relativeTimeFormat, value, unit )
 * PartitionRelativeTimePattern ( relativeTimeFormat, value, unit )
 *
 * Returns a relative time as a string formatted according to the effective
 * locale and the formatting options of the given RelativeTimeFormat.
 */
static bool FormatRelativeTime(
    JSContext* cx, Handle<RelativeTimeFormatObject*> relativeTimeFormat,
    double value, Handle<JSString*> unit, bool formatToParts,
    MutableHandle<JS::Value> rvalue) {
  // PartitionRelativeTimePattern, step 1.
  if (!std::isfinite(value)) {
    JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr,
                              JSMSG_DATE_NOT_FINITE, "RelativeTimeFormat",
                              formatToParts ? "formatToParts" : "format");
    return false;
  }

  // PartitionRelativeTimePattern, step 2.
  mozilla::intl::RelativeTimeFormat::FormatUnit relTimeUnit;
  if (!SingularRelativeTimeUnit(cx, unit, &relTimeUnit)) {
    return false;
  }

  auto* rtf = GetOrCreateRelativeTimeFormat(cx, relativeTimeFormat);
  if (!rtf) {
    return false;
  }

  // PartitionRelativeTimePattern, steps 3-14.
  // FormatRelativeTimeToParts, steps 2-5.
  if (formatToParts) {
    mozilla::intl::NumberPartVector parts;
    auto result = rtf->formatToParts(value, relTimeUnit, parts);
    if (result.isErr()) {
      ReportInternalError(cx, result.unwrapErr());
      return false;
    }

    Rooted<JSString*> str(cx, NewStringCopy<CanGC>(cx, result.unwrap()));
    if (!str) {
      return false;
    }

    auto unitType = ToRelativeTimeFormatUnit(relTimeUnit);
    return FormattedRelativeTimeToParts(cx, str, parts, unitType, rvalue);
  }

  // PartitionRelativeTimePattern, steps 3-14.
  // FormatRelativeTime, steps 2-4.
  FormatBuffer<char16_t, INITIAL_CHAR_BUFFER_SIZE> buffer(cx);
  auto result = rtf->format(value, relTimeUnit, buffer);
  if (result.isErr()) {
    ReportInternalError(cx, result.unwrapErr());
    return false;
  }

  auto* str = buffer.toString(cx);
  if (!str) {
    return false;
  }

  rvalue.setString(str);
  return true;
}

static bool IsRelativeTimeFormat(Handle<JS::Value> v) {
  return v.isObject() && v.toObject().is<RelativeTimeFormatObject>();
}

/**
 * Intl.RelativeTimeFormat.prototype.format ( value, unit )
 */
static bool relativeTimeFormat_format(JSContext* cx, const CallArgs& args) {
  Rooted<RelativeTimeFormatObject*> relativeTimeFormat(
      cx, &args.thisv().toObject().as<RelativeTimeFormatObject>());

  // Step 3.
  double value;
  if (!JS::ToNumber(cx, args.get(0), &value)) {
    return false;
  }

  // Step 4.
  Rooted<JSString*> unit(cx, JS::ToString(cx, args.get(1)));
  if (!unit) {
    return false;
  }

  // Step 5.
  return FormatRelativeTime(cx, relativeTimeFormat, value, unit,
                            /* formatToParts= */ false, args.rval());
}

/**
 * Intl.RelativeTimeFormat.prototype.format ( value, unit )
 */
static bool relativeTimeFormat_format(JSContext* cx, unsigned argc, Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  return CallNonGenericMethod<IsRelativeTimeFormat, relativeTimeFormat_format>(
      cx, args);
}

/**
 * Intl.RelativeTimeFormat.prototype.formatToParts ( value, unit )
 */
static bool relativeTimeFormat_formatToParts(JSContext* cx,
                                             const CallArgs& args) {
  Rooted<RelativeTimeFormatObject*> relativeTimeFormat(
      cx, &args.thisv().toObject().as<RelativeTimeFormatObject>());

  // Step 3.
  double value;
  if (!JS::ToNumber(cx, args.get(0), &value)) {
    return false;
  }

  // Step 4.
  Rooted<JSString*> unit(cx, JS::ToString(cx, args.get(1)));
  if (!unit) {
    return false;
  }

  // Step 5.
  return FormatRelativeTime(cx, relativeTimeFormat, value, unit,
                            /* formatToParts= */ true, args.rval());
}

/**
 * Intl.RelativeTimeFormat.prototype.formatToParts ( value, unit )
 */
static bool relativeTimeFormat_formatToParts(JSContext* cx, unsigned argc,
                                             Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  return CallNonGenericMethod<IsRelativeTimeFormat,
                              relativeTimeFormat_formatToParts>(cx, args);
}

/**
 * Intl.RelativeTimeFormat.prototype.resolvedOptions ( )
 */
static bool relativeTimeFormat_resolvedOptions(JSContext* cx,
                                               const CallArgs& args) {
  Rooted<RelativeTimeFormatObject*> relativeTimeFormat(
      cx, &args.thisv().toObject().as<RelativeTimeFormatObject>());

  if (!ResolveLocale(cx, relativeTimeFormat)) {
    return false;
  }
  auto rtfOptions = *relativeTimeFormat->getOptions();

  // Step 3.
  Rooted<IdValueVector> options(cx, cx);

  // Step 4.
  if (!options.emplaceBack(NameToId(cx->names().locale),
                           StringValue(relativeTimeFormat->getLocale()))) {
    return false;
  }

  auto* style = NewStringCopy<CanGC>(cx, StyleToString(rtfOptions.style));
  if (!style) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().style), StringValue(style))) {
    return false;
  }

  auto* numeric = NewStringCopy<CanGC>(cx, NumericToString(rtfOptions.numeric));
  if (!numeric) {
    return false;
  }
  if (!options.emplaceBack(NameToId(cx->names().numeric),
                           StringValue(numeric))) {
    return false;
  }

  if (!options.emplaceBack(
          NameToId(cx->names().numberingSystem),
          StringValue(relativeTimeFormat->getNumberingSystem()))) {
    return false;
  }

  // Step 5.
  auto* result = NewPlainObjectWithUniqueNames(cx, options);
  if (!result) {
    return false;
  }
  args.rval().setObject(*result);
  return true;
}

/**
 * Intl.RelativeTimeFormat.prototype.resolvedOptions ( )
 */
static bool relativeTimeFormat_resolvedOptions(JSContext* cx, unsigned argc,
                                               Value* vp) {
  // Steps 1-2.
  CallArgs args = CallArgsFromVp(argc, vp);
  return CallNonGenericMethod<IsRelativeTimeFormat,
                              relativeTimeFormat_resolvedOptions>(cx, args);
}

/**
 * Intl.RelativeTimeFormat.supportedLocalesOf ( locales [ , options ] )
 */
static bool relativeTimeFormat_supportedLocalesOf(JSContext* cx, unsigned argc,
                                                  Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);

  // Steps 1-3.
  auto* array = SupportedLocalesOf(cx, AvailableLocaleKind::RelativeTimeFormat,
                                   args.get(0), args.get(1));
  if (!array) {
    return false;
  }
  args.rval().setObject(*array);
  return true;
}
