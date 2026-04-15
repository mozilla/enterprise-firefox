/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Test aria-brailleRoleDescription
 */
addAccessibleTask(
  `<article id="test" aria-roledescription="slide" aria-brailleroledescription="sld" aria-labelledby="slide1heading">
		<h1 id="slide1heading">Welcome to my talk</h1>
	</article>
	<p id="p">This here is text without braille role description</p>`,
  async (browser, accDoc) => {
    let elem = getNativeInterface(accDoc, "test");
    is(
      elem.getAttributeValue("AXBrailleRoleDescription"),
      "sld",
      `Test: Correct braille role description`
    );
    let p = getNativeInterface(accDoc, "p");
    ok(
      !p.attributeNames.includes("AXBrailleRoleDescription"),
      "The AXBrailleRoleDescription selector should be blocked for nodes without aria-brailleroledescription specified"
    );
  }
);
