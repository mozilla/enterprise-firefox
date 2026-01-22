# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

debug-model-management-group =
  .label = DEBUG model management
debug-model-management-feature =
  .label = features
debug-model-management-install =
  .label = install feature
debug-model-management-uninstall =
  .label = uninstall feature
debug-model-management-uninstall-all =
  .label = uninstall all features

pane-ai-features-title = AI Features
category-ai-features =
    .tooltiptext = { pane-ai-features-title }

## AI Features section

preferences-ai-features-header =
    .heading = AI features
try-ai-features-group =
    .label = Try AI features
    .description = All features are optional. Don’t want to see any of them? You can remove AI below.
try-ai-features-chatbot-provider =
    .label = Access chatbot providers in sidebar
    .description = Keep a chatbot in view as you browse. Switch anytime.
# This labels the unset option for AI Chatbot selection, the other options are brand names like "ChatGPT" and "Anthropic Claude"
try-ai-features-chatbot-choose-label =
    .label = Choose provider

try-ai-features-ai-window =
    .label = AI Window
    .description = A separate window that learns as you browse. Get quick answers about your tabs and a more personalized experience.
try-ai-features-ai-window-activate-link =
    .label = Activate AI Window

ai-window-features-group =
    .label = Smart Window
    .description = Ask questions, compare pages, and more in a separate window with a built-in assistant. Smart Window can learn as you browse, for a more personalized experience.

ai-window-personalize-button =
    .label = Personalize Smart Window

ai-window-personalize-header =
    .heading = Smart Window

ai-window-memories-section =
    .label = Memories
    .description = Manage what Smart Window learns from your activity.

ai-window-learn-from-activity =
    .label = Learn from your activity
    .description = Smart Window can use your browsing and chat activity to create memories and personalize responses.

ai-window-manage-memories-button =
    .label = Manage memories

ai-window-manage-memories-header =
    .heading = Manage memories
    .description = Memories are what Smart Window learns from your activity.

ai-window-no-memories =
    .label = No memories yet
    .description = As Smart Window learns from your activity, you’ll see memories here.

ai-window-no-memories-learning-off =
    .label = No memories to show
    .description = Learning from activity is off, so Smart Window isn’t creating memories.

ai-window-delete-all-memories-button =
    .label = Delete all

ai-window-delete-all-memories-title = Delete all memories?
ai-window-delete-all-memories-message = This also prevents Smart Window from creating similar memories later. If you don’t want Smart Window to learn from your activity anymore, you can turn this off in settings.
ai-window-delete-all-memories-confirm = Delete
ai-window-delete-all-memories-cancel = Cancel

# Variables:
#   $label (String) - The memory summary text that will be deleted
ai-window-memory-delete-button =
    .title = Delete memory
    .aria-label = Delete { $label }
