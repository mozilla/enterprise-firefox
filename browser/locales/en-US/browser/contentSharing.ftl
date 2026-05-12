# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Variables
##   $count (number) - The number of tabs

content-sharing-modal-more-tabs =
    { $count ->
       *[other] +{ $count } more
    }

content-sharing-tabs-title =
    { $count ->
        [one] { $count } tab
       *[other] { $count } tabs
    }

content-sharing-modal-view-page =
  .label = View page

content-sharing-modal-copy-link =
  .label = Copy link

content-sharing-modal-link-copied =
  .label = Link copied

content-sharing-modal-sign-in =
  .label = Sign in to share links

content-sharing-modal-title = Share this collection of links on any browser

content-sharing-modal-description = Create a public page for these links that’s easy to share. Once created, the page can’t be edited or deleted and expires in 7 days.
