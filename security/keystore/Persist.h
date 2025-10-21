/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 et lcs=trail\:.,tab\:>~ :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef Persist_h
#define Persist_h

#include "mozilla/StaticMutex.h"
#include "nsStringFwd.h"
#include "seccomon.h"

namespace mozilla::storage::key {
extern mozilla::StaticMutex sKeyMutex;

void ShutdownStorage();

void SetCurrentProfilePath(const nsAString& aPath);
nsresult GetCurrentProfilePath(nsAString& aPath);
nsresult FetchOrCreateKey(nsAutoCString& aIdentifier, SECItem* aData);
}  // namespace mozilla::storage::key

#endif  // Persist_h
