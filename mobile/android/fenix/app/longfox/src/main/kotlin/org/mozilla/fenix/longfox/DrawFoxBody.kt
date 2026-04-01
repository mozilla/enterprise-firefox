/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

package org.mozilla.fenix.longfox

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope

/**
 * Draw the body of the fox as a single filled path with rounded outer corners.
 * Each outer corner (where both orthogonal neighbours are absent from the body) is rounded;
 * inner corners and shared edges remain sharp so adjacent cells merge seamlessly.
 *
 * The first and last body cells are rounded at their free ends, connecting smoothly to
 * the head and tail images.
 *
 * @receiver the draw scope for the game canvas
 * @param state the current game state
 * @param brush the brush to fill the body with
 */
fun DrawScope.drawBody(state: GameState, brush: Brush) {
    val foxBody = state.fox.drop(1).dropLast(1)
    if (foxBody.isEmpty()) return
    val bodySet = foxBody.toHashSet()
    val cornerRadius = state.cellSize / 2
    val path = Path()
    foxBody.forEach { cell ->
        val hasLeft = GridPoint(cell.x - 1, cell.y) in bodySet
        val hasRight = GridPoint(cell.x + 1, cell.y) in bodySet
        val hasUp = GridPoint(cell.x, cell.y - 1) in bodySet
        val hasDown = GridPoint(cell.x, cell.y + 1) in bodySet
        addRoundedCell(
            path = path,
            left = cell.x * state.cellSize,
            top = cell.y * state.cellSize,
            cellSize = state.cellSize,
            cornerRadius = cornerRadius,
            roundTopLeft = !hasLeft && !hasUp,
            roundTopRight = !hasRight && !hasUp,
            roundBottomRight = !hasRight && !hasDown,
            roundBottomLeft = !hasLeft && !hasDown,
        )
    }
    drawPath(path, brush)
}

/**
 * Adds a rectangle to [path] with optional rounded corners.
 * Pass `true` for any corner to replace the sharp 90° angle with a quarter-circle arc of radius [cornerRadius].
 */
private fun addRoundedCell(
    path: Path,
    left: Float,
    top: Float,
    cellSize: Float,
    cornerRadius: Float,
    roundTopLeft: Boolean,
    roundTopRight: Boolean,
    roundBottomRight: Boolean,
    roundBottomLeft: Boolean,
) {
    val right = left + cellSize
    val bottom = top + cellSize

    path.moveTo(left + if (roundTopLeft) cornerRadius else 0f, top)

    if (roundTopRight) {
        path.lineTo(right - cornerRadius, top)
        path.arcTo(Rect(right - 2 * cornerRadius, top, right, top + (2 * cornerRadius)), -90f, 90f, false)
    } else {
        path.lineTo(right, top)
    }

    if (roundBottomRight) {
        path.lineTo(right, bottom - cornerRadius)
        path.arcTo(Rect(right - 2 * cornerRadius, bottom - (2 * cornerRadius), right, bottom), 0f, 90f, false)
    } else {
        path.lineTo(right, bottom)
    }

    if (roundBottomLeft) {
        path.lineTo(left + cornerRadius, bottom)
        path.arcTo(Rect(left, bottom - 2 * cornerRadius, left + (2 * cornerRadius), bottom), 90f, 90f, false)
    } else {
        path.lineTo(left, bottom)
    }

    if (roundTopLeft) {
        path.lineTo(left, top + cornerRadius)
        path.arcTo(Rect(left, top, left + 2 * cornerRadius, top + (2 * cornerRadius)), 180f, 90f, false)
    } else {
        path.lineTo(left, top)
    }

    path.close()
}
