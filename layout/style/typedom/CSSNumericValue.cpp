/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/CSSNumericValue.h"

#include "mozilla/AlreadyAddRefed.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/ServoStyleConsts.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/dom/BindingDeclarations.h"
#include "mozilla/dom/CSSMathSum.h"
#include "mozilla/dom/CSSNumericValueBinding.h"
#include "mozilla/dom/CSSUnitValue.h"

namespace mozilla::dom {

CSSNumericValue::CSSNumericValue(nsCOMPtr<nsISupports> aParent)
    : CSSStyleValue(std::move(aParent)),
      mNumericValueType(NumericValueType::Uninitialized) {}

CSSNumericValue::CSSNumericValue(nsCOMPtr<nsISupports> aParent,
                                 NumericValueType aNumericValueType)
    : CSSStyleValue(std::move(aParent), StyleValueType::NumericValue),
      mNumericValueType(aNumericValueType) {}

// static
RefPtr<CSSNumericValue> CSSNumericValue::Create(
    nsCOMPtr<nsISupports> aParent, const StyleNumericValue& aNumericValue) {
  RefPtr<CSSNumericValue> numericValue;

  switch (aNumericValue.tag) {
    case StyleNumericValue::Tag::Unit: {
      auto unitValue = aNumericValue.AsUnit();

      numericValue = CSSUnitValue::Create(aParent, unitValue);
      break;
    }

    case StyleNumericValue::Tag::Sum: {
      auto mathSum = aNumericValue.AsSum();

      numericValue = CSSMathSum::Create(aParent, mathSum);
      break;
    }
  }

  return numericValue;
}

JSObject* CSSNumericValue::WrapObject(JSContext* aCx,
                                      JS::Handle<JSObject*> aGivenProto) {
  return CSSNumericValue_Binding::Wrap(aCx, this, aGivenProto);
}

// start of CSSNumericValue Web IDL implementation

already_AddRefed<CSSNumericValue> CSSNumericValue::Add(
    const Sequence<OwningCSSNumberish>& aValues, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

already_AddRefed<CSSNumericValue> CSSNumericValue::Sub(
    const Sequence<OwningCSSNumberish>& aValues, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

already_AddRefed<CSSNumericValue> CSSNumericValue::Mul(
    const Sequence<OwningCSSNumberish>& aValues, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

already_AddRefed<CSSNumericValue> CSSNumericValue::Div(
    const Sequence<OwningCSSNumberish>& aValues, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

already_AddRefed<CSSNumericValue> CSSNumericValue::Min(
    const Sequence<OwningCSSNumberish>& aValues, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

already_AddRefed<CSSNumericValue> CSSNumericValue::Max(
    const Sequence<OwningCSSNumberish>& aValues, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

bool CSSNumericValue::Equals(const Sequence<OwningCSSNumberish>& aValue) {
  return false;
}

already_AddRefed<CSSUnitValue> CSSNumericValue::To(const nsACString& aUnit,
                                                   ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

already_AddRefed<CSSMathSum> CSSNumericValue::ToSum(
    const Sequence<nsCString>& aUnits, ErrorResult& aRv) {
  aRv.Throw(NS_ERROR_NOT_IMPLEMENTED);
  return nullptr;
}

void CSSNumericValue::Type(CSSNumericType& aRetVal) {}

// https://drafts.css-houdini.org/css-typed-om-1/#dom-cssnumericvalue-parse
//
// static
already_AddRefed<CSSNumericValue> CSSNumericValue::Parse(
    const GlobalObject& aGlobal, const nsACString& aCssText, ErrorResult& aRv) {
  // Step 1 & 2 & 3.
  auto declaration = WrapUnique(Servo_NumericDeclaration_Parse(&aCssText));
  if (!declaration) {
    aRv.ThrowSyntaxError("Failed to parse CSS text");
    return nullptr;
  }

  // Step 4.
  StyleNumericValueResult result = StyleNumericValueResult::Unsupported();
  Servo_NumericDeclaration_GetValue(declaration.get(), &result);
  if (result.IsUnsupported()) {
    aRv.Throw(NS_ERROR_UNEXPECTED);
    return nullptr;
  }

  RefPtr<CSSNumericValue> numericValue =
      Create(aGlobal.GetAsSupports(), result.AsNumeric());
  return numericValue.forget();
}

// end of CSSNumericValue Web IDL implementation

bool CSSNumericValue::IsCSSUnitValue() const {
  return mNumericValueType == NumericValueType::UnitValue;
}

bool CSSNumericValue::IsCSSMathSum() const {
  return mNumericValueType == NumericValueType::MathSum;
}

void CSSNumericValue::ToCssTextWithProperty(const CSSPropertyId& aPropertyId,
                                            nsACString& aDest) const {
  switch (GetNumericValueType()) {
    case NumericValueType::MathSum: {
      const CSSMathSum& mathSum = GetAsCSSMathSum();

      mathSum.ToCssTextWithProperty(aPropertyId, aDest);
      break;
    }

    case NumericValueType::UnitValue: {
      const CSSUnitValue& unitValue = GetAsCSSUnitValue();

      unitValue.ToCssTextWithProperty(aPropertyId, aDest);
      break;
    }

    case NumericValueType::Uninitialized:
      break;
  }
}

CSSNumericValue& CSSStyleValue::GetAsCSSNumericValue() {
  MOZ_DIAGNOSTIC_ASSERT(mStyleValueType == StyleValueType::NumericValue);

  return *static_cast<CSSNumericValue*>(this);
}

}  // namespace mozilla::dom
