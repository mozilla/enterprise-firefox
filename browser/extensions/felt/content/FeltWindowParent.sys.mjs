/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-side actor for the SSO callback page.
 *
 * WindowGlobalParent.getActor() requires a parent class to be registered.
 * The webProgress fallback in window.js calls
 *   windowGlobal.getActor("FeltWindow").sendQuery("ExtractTokens")
 * which force-creates the actor pair (parent + child) and delivers the
 * message to the child process. Without this class, getActor() would fail
 * because no parent module is registered for the "FeltWindow" actor.
 *
 * See the webProgress fallback in window.js for details. A cross-process
 * navigation during the SSO redirect chain can cause the child-side
 * DOMContentLoaded event to never reach the FeltWindowChild actor.
 */
export class FeltWindowParent extends JSWindowActorParent {}
