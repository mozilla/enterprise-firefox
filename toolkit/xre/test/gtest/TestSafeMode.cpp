/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <string>

#include "gtest/gtest.h"

#include "mozilla/SafeMode.h"

using namespace mozilla;

namespace {

// Sets an environment variable for the lifetime of this object.
class AutoSetEnv {
 public:
  AutoSetEnv(const char* aName, const char* aValue) : mName(aName) {
    SaveToEnv((mName + "=" + aValue).c_str());
  }

  ~AutoSetEnv() {
    // An empty value is how startup clears these too, and EnvHasValue treats
    // it as unset.
    SaveToEnv((mName + "=").c_str());
  }

 private:
  const std::string mName;
};

Maybe<bool> SafeModeRequestedWithoutArgs() {
  char arg0[] = "firefox";
  char* argv[] = {arg0, nullptr};
  int argc = 1;
  return IsSafeModeRequested(argc, argv, SafeModeFlag::NoKeyPressCheck);
}

Maybe<bool> SafeModeRequestedWithArg() {
  char arg0[] = "firefox";
  char arg1[] = "--safe-mode";
  char* argv[] = {arg0, arg1, nullptr};
  int argc = 2;
  return IsSafeModeRequested(argc, argv, SafeModeFlag::NoKeyPressCheck);
}

}  // namespace

TEST(SafeMode, RestartRequestsSafeMode)
{
  AutoSetEnv restart("MOZ_SAFE_MODE_RESTART", "1");
  Maybe<bool> requested = SafeModeRequestedWithoutArgs();
  ASSERT_TRUE(requested.isSome());
  EXPECT_TRUE(*requested);
}

TEST(SafeMode, EnterpriseDisableOverridesRestart)
{
  AutoSetEnv restart("MOZ_SAFE_MODE_RESTART", "1");
  AutoSetEnv disable("MOZ_ENTERPRISE_DISABLE_SAFE_MODE", "1");
  Maybe<bool> requested = SafeModeRequestedWithoutArgs();
  ASSERT_TRUE(requested.isSome());
  EXPECT_FALSE(*requested);
}

TEST(SafeMode, EnterpriseDisableOverridesArgument)
{
  AutoSetEnv disable("MOZ_ENTERPRISE_DISABLE_SAFE_MODE", "1");
  Maybe<bool> requested = SafeModeRequestedWithArg();
  ASSERT_TRUE(requested.isSome());
  EXPECT_FALSE(*requested);
}
