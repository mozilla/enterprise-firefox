/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/SpeculationRules.h"

#include "mozilla/dom/SpeculationRuleSet.h"
#include "nsCycleCollectionParticipant.h"
#include "nsIScriptElement.h"
#include "nsIURI.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_CLASS(SpeculationRules)

NS_IMPL_CYCLE_COLLECTION_TRAVERSE_BEGIN(SpeculationRules)
  for (const auto& entry : tmp->mRuleSetsFromScript) {
    NS_CYCLE_COLLECTION_NOTE_EDGE_NAME(cb, "mRuleSetsFromScript key");
    cb.NoteXPCOMChild(entry.GetKey());
  }
NS_IMPL_CYCLE_COLLECTION_TRAVERSE_END

NS_IMPL_CYCLE_COLLECTION_UNLINK_BEGIN(SpeculationRules)
  NS_IMPL_CYCLE_COLLECTION_UNLINK(mRuleSetsFromScript)
NS_IMPL_CYCLE_COLLECTION_UNLINK_END

// https://html.spec.whatwg.org/#register-speculation-rules
void SpeculationRules::RegisterFromScript(
    nsIScriptElement* aScriptElement, UniquePtr<SpeculationRuleSet> aRuleSet) {
  mRuleSetsFromScript.InsertOrUpdate(aScriptElement, std::move(aRuleSet));
}

// html.spec.whatwg.org/#unregister-speculation-rules
void SpeculationRules::Unregister(nsIScriptElement* aScriptElement) {
  mRuleSetsFromScript.Remove(aScriptElement);
}

}  // namespace mozilla::dom
