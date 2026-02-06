/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test for attr() in rule view.

const TEST_URI = `data:text/html,<meta charset=utf8>
  <style>
    div::before {
      content: attr(data-before);
    }

    div::after {
      content: attr(data-after, "✕");
      display: list-item;
    }

    div::after::marker {
      content: attr(data-marker, "-");
    }
  </style>
  <div id=with-attr data-before="→" data-after="←" data-marker="❥"></div>
  <div id=without-attr></div>`;

const NS = "http://www.w3.org/1999/xhtml";

add_task(async function () {
  await addTab(TEST_URI);
  const { inspector, view } = await openRuleView();

  const withAttrNodeFront = await getNodeFront("#with-attr", inspector);
  await selectNode(withAttrNodeFront, inspector);
  is(
    getRuleViewProperty(view, "div::before", "content").valueSpan.innerHTML,
    `attr(<span xmlns="${NS}">data-before</span>)`,
    `"data-before" doesn't have unmatched style on #with-attr node`
  );
  is(
    getRuleViewProperty(view, "div::after", "content").valueSpan.innerHTML,
    `attr(<span xmlns="${NS}">data-after</span>, <span xmlns="${NS}" class="inspector-unmatched">"✕"</span>)`,
    `"data-after" fallback has unmatched style on #with-attr node`
  );

  // Select #with-attr::after element
  const withAttrChildren =
    await inspector.markup.walker.children(withAttrNodeFront);
  const withAttrAfterNode = withAttrChildren.nodes.at(-1);
  await selectNode(withAttrAfterNode, inspector);
  is(
    getRuleViewProperty(view, "div::after", "content").valueSpan.innerHTML,
    `attr(<span xmlns="${NS}">data-after</span>, <span xmlns="${NS}" class="inspector-unmatched">"✕"</span>)`,
    `"data-after" fallback has unmatched style on #with-attr::after node`
  );

  // Select ::after::marker element
  const withAttrAfterChildren =
    await inspector.markup.walker.children(withAttrAfterNode);
  const withAttrAfterMarkerNode = withAttrAfterChildren.nodes[0];
  await selectNode(withAttrAfterMarkerNode, inspector);
  // Note that in the page, the fallback is being used, but shouldn't (see Bug 2012042),
  // so we're showing the right thing here
  is(
    getRuleViewProperty(view, "div::after::marker", "content").valueSpan
      .innerHTML,
    `attr(<span xmlns="${NS}">data-marker</span>, <span xmlns="${NS}" class="inspector-unmatched">"-"</span>)`,
    `"data-marker" fallback has unmatched style on #with-attr::after::marker node`
  );

  const withoutAttrNodeFront = await getNodeFront("#without-attr", inspector);
  await selectNode(withoutAttrNodeFront, inspector);
  is(
    getRuleViewProperty(view, "div::before", "content").valueSpan.innerHTML,
    `attr(<span xmlns="${NS}" class="inspector-unmatched">data-before</span>)`,
    `"data-before" has unmatched style on #without-attr node`
  );
  is(
    getRuleViewProperty(view, "div::after", "content").valueSpan.innerHTML,
    `attr(<span xmlns="${NS}" class="inspector-unmatched">data-after</span>, <span xmlns="${NS}">"✕"</span>)`,
    `"data-after" has unmatched style on #without-attr node`
  );

  // Select #with-attr::after element
  const withoutAttrChildren =
    await inspector.markup.walker.children(withoutAttrNodeFront);
  const withoutAttrAfterNode = withoutAttrChildren.nodes.at(-1);
  await selectNode(withoutAttrAfterNode, inspector);
  is(
    getRuleViewProperty(view, "div::after", "content").valueSpan.innerHTML,
    `attr(<span xmlns="${NS}" class="inspector-unmatched">data-after</span>, <span xmlns="${NS}">"✕"</span>)`,
    `"data-after" has unmatched style on #without-attr::after node`
  );

  // Select ::after::marker element
  const withoutAttrAfterChildren =
    await inspector.markup.walker.children(withoutAttrAfterNode);
  const withoutAttrAfterMarkerNode = withoutAttrAfterChildren.nodes[0];
  await selectNode(withoutAttrAfterMarkerNode, inspector);
  is(
    getRuleViewProperty(view, "div::after::marker", "content").valueSpan
      .innerHTML,
    `attr(<span xmlns="${NS}" class="inspector-unmatched">data-marker</span>, <span xmlns="${NS}">"-"</span>)`,
    `"data-marker" has unmatched style on #without-attr::after::marker node`
  );
});
