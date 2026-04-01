/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.ui.efficiency.navigation

import android.util.Log

object NavigationRegistry {
    private val graph = mutableMapOf<String, MutableList<NavigationEdge>>()

    fun register(from: String, to: String, steps: List<NavigationStep>) {
        val edge = NavigationEdge(from, to, steps)
        graph.getOrPut(from) { mutableListOf() }.add(edge)

        Log.i("NavigationRegistry", "📌 Registered navigation: $from -> $to with ${steps.size} step(s)")
        steps.forEachIndexed { index, step ->
            Log.i("NavigationRegistry", "   Step ${index + 1}: $step")
        }
    }

    fun findPath(from: String, to: String): List<NavigationStep>? {
        if (from == to) return emptyList()
        val visited = mutableSetOf(from)
        val queue = ArrayDeque<Pair<String, List<NavigationStep>>>()
        queue.add(from to emptyList())

        while (queue.isNotEmpty()) {
            val (current, steps) = queue.removeFirst()
            for (edge in graph[current].orEmpty()) {
                if (edge.to !in visited) {
                    val newSteps = steps + edge.steps
                    if (edge.to == to) return newSteps
                    visited.add(edge.to)
                    queue.add(edge.to to newSteps)
                }
            }
        }
        return null
    }

    fun logGraph() {
        Log.i("NavigationRegistry", "🧭 Current navigation graph:")
        for ((from, edges) in graph) {
            for (edge in edges) {
                Log.i("NavigationRegistry", " - $from -> ${edge.to} [${edge.steps.size} step(s)]")
            }
        }
    }
}
