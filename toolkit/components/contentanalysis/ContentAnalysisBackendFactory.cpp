/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ContentAnalysisBackend.h"

#include "ExternalAgentBackend.h"
#include "mozilla/RefPtr.h"

namespace mozilla::contentanalysis {

already_AddRefed<ContentAnalysisBackend> CreateBackend() {
  return MakeAndAddRef<ExternalAgentBackend>();
}

}  // namespace mozilla::contentanalysis
