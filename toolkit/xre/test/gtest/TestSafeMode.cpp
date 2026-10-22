/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"

#if defined(XP_MACOSX)
// SafeMode.h uses Carbon for its key press check without including it.
#  include <Carbon/Carbon.h>
#endif

#include "mozilla/SafeMode.h"

using namespace mozilla;

namespace {

// An empty value is how startup clears these too, and EnvHasValue treats it as
// unset.
class AutoClearSafeModeEnv {
 public:
  AutoClearSafeModeEnv() { Clear(); }
  ~AutoClearSafeModeEnv() { Clear(); }

 private:
  static void Clear() {
    SaveToEnv("MOZ_SAFE_MODE_RESTART=");
    SaveToEnv("MOZ_ENTERPRISE_DISABLE_SAFE_MODE=");
  }
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
  AutoClearSafeModeEnv clearEnv;
  SaveToEnv("MOZ_SAFE_MODE_RESTART=1");
  Maybe<bool> requested = SafeModeRequestedWithoutArgs();
  ASSERT_TRUE(requested.isSome());
  EXPECT_TRUE(*requested);
}

TEST(SafeMode, EnterpriseDisableOverridesRestart)
{
  AutoClearSafeModeEnv clearEnv;
  SaveToEnv("MOZ_SAFE_MODE_RESTART=1");
  SaveToEnv("MOZ_ENTERPRISE_DISABLE_SAFE_MODE=1");
  Maybe<bool> requested = SafeModeRequestedWithoutArgs();
  ASSERT_TRUE(requested.isSome());
  EXPECT_FALSE(*requested);
}

TEST(SafeMode, EnterpriseDisableOverridesArgument)
{
  AutoClearSafeModeEnv clearEnv;
  SaveToEnv("MOZ_ENTERPRISE_DISABLE_SAFE_MODE=1");
  Maybe<bool> requested = SafeModeRequestedWithArg();
  ASSERT_TRUE(requested.isSome());
  EXPECT_FALSE(*requested);
}
