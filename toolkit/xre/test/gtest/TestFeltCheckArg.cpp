/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <initializer_list>
#include <string>
#include <vector>

#include "gtest/gtest.h"

#include "mozilla/toolkit/components/felt/felt.h"
#include "nsAppRunner.h"

// Runs aCheck() with gArgc/gArgv temporarily set to aArgs.
template <typename F>
static bool WithArgs(std::initializer_list<const char*> aArgs, F aCheck) {
  std::vector<std::string> storage{"firefox"};
  storage.insert(storage.end(), aArgs.begin(), aArgs.end());
  std::vector<char*> argv;
  for (auto& s : storage) {
    argv.push_back(s.data());
  }
  argv.push_back(nullptr);

  const int savedArgc = gArgc;
  char** const savedArgv = gArgv;
  gArgc = static_cast<int>(storage.size());
  gArgv = argv.data();
  const bool result = aCheck();
  gArgc = savedArgc;
  gArgv = savedArgv;
  return result;
}

static bool HasArg(std::initializer_list<const char*> aArgs, const char* aArg) {
  return WithArgs(aArgs, [&] { return felt_check_arg_exists(aArg); });
}

static bool HasChrome(std::initializer_list<const char*> aArgs) {
  return WithArgs(aArgs, [] { return felt_has_chrome_arg(); });
}

TEST(FeltCheckArg, Forms)
{
  EXPECT_TRUE(HasArg({"-felt", "socket"}, "felt"));
  EXPECT_TRUE(HasArg({"--FELT=socket"}, "felt"));
  EXPECT_FALSE(HasArg({"----felt----ui"}, "feltui"));
  EXPECT_FALSE(HasArg({"/felt:socket"}, "felt"));
  EXPECT_FALSE(HasArg({"/safe-mode:x"}, "safe-mode"));
}

TEST(FeltCheckArg, Chrome)
{
  EXPECT_TRUE(HasChrome({"-chrome", "chrome://foo/content/bar.xhtml"}));
  EXPECT_TRUE(HasChrome({"--CHROME"}));
  EXPECT_TRUE(HasChrome({"-chrome=chrome://foo/content/bar.xhtml"}));
  EXPECT_TRUE(HasChrome({"--chrome=chrome://foo/content/bar.xhtml"}));
  EXPECT_FALSE(HasChrome({"-url", "chrome://foo/content/bar.xhtml"}));
  EXPECT_FALSE(HasChrome({"--chromium"}));
  EXPECT_FALSE(HasChrome({"-chrome:x"}));
#ifdef XP_WIN
  EXPECT_TRUE(HasChrome({"/chrome", "chrome://foo/content/bar.xhtml"}));
  EXPECT_TRUE(HasChrome({"/chrome:chrome://foo/content/bar.xhtml"}));
  EXPECT_TRUE(HasChrome({"/CHROME:x"}));
  EXPECT_TRUE(HasChrome({"/chrome:"}));
  EXPECT_FALSE(HasChrome({"/chrome=chrome://foo/content/bar.xhtml"}));
  EXPECT_FALSE(HasChrome({"/chromium:x"}));
#else
  EXPECT_FALSE(HasChrome({"/chrome:chrome://foo/content/bar.xhtml"}));
#endif
}
