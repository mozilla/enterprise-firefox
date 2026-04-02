/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.compose.browser.awesomebar.internal.optimizedsuggestions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewLightDark
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.unit.dp
import mozilla.components.compose.base.theme.AcornTheme
import mozilla.components.compose.base.theme.acornPrivateColorScheme
import mozilla.components.compose.base.theme.privateColorPalette
import mozilla.components.compose.base.theme.success
import mozilla.components.compose.browser.awesomebar.R
import mozilla.components.compose.browser.awesomebar.internal.utils.SportSuggestionDataProvider
import mozilla.components.compose.browser.awesomebar.internal.utils.SportSuggestionPreviewModel
import mozilla.components.compose.browser.awesomebar.internal.utils.stringResId
import mozilla.components.concept.awesomebar.optimizedsuggestions.SportSuggestionDate
import mozilla.components.concept.awesomebar.optimizedsuggestions.SportSuggestionStatus
import mozilla.components.concept.awesomebar.optimizedsuggestions.SportSuggestionStatusType
import mozilla.components.concept.awesomebar.optimizedsuggestions.SportSuggestionTeam
import mozilla.components.ui.icons.R as iconsR

@Composable
internal fun SportSuggestion(
    sport: String,
    status: SportSuggestionStatus,
    statusType: SportSuggestionStatusType,
    date: SportSuggestionDate,
    homeTeam: SportSuggestionTeam,
    awayTeam: SportSuggestionTeam,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shouldDisplayScore by remember(homeTeam, awayTeam) {
        derivedStateOf {
            homeTeam.score != null && awayTeam.score != null
        }
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(color = MaterialTheme.colorScheme.surface)
            .clickable(enabled = true, onClick = onClick),
    ) {
        Column(
            modifier = Modifier
                .padding(
                    horizontal = AcornTheme.layout.space.static200,
                    vertical = AcornTheme.layout.space.static300,
                ),
        ) {
            SuggestionHeader(
                sport = sport,
                status = status,
                statusType = statusType,
                date = date,
            )

            HorizontalDivider(
                color = MaterialTheme.colorScheme.outlineVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )

            SuggestionTeams(
                awayTeam = awayTeam,
                homeTeam = homeTeam,
                shouldDisplayScore = shouldDisplayScore,
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

@Composable
private fun SuggestionHeader(
    sport: String,
    status: SportSuggestionStatus,
    statusType: SportSuggestionStatusType,
    date: SportSuggestionDate,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        getSportsIcon(sport)?.let {
            Icon(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(color = MaterialTheme.colorScheme.surfaceContainerHighest)
                    .padding(AcornTheme.layout.space.static50),
                painter = it,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
            )
        }

        Spacer(modifier = Modifier.width(AcornTheme.layout.space.static100))

        Text(
            text = buildString {
                append("$sport · ")
                status.stringResId?.let {
                    append("${stringResource(it)} · ")
                }
                append(getSportsDate(date))
            },
            modifier = Modifier
                .weight(1f)
                .padding(end = 16.dp),
            overflow = TextOverflow.Ellipsis,
            maxLines = 1,
            style = AcornTheme.typography.body2,
            color = MaterialTheme.colorScheme.onSurface,
        )

        if (statusType == SportSuggestionStatusType.LIVE) {
            LiveStatus()
        }
    }
}

@Composable
private fun SuggestionTeams(
    awayTeam: SportSuggestionTeam,
    homeTeam: SportSuggestionTeam,
    shouldDisplayScore: Boolean,
) {
    val teamContentDescription = getTeamContentDescription(shouldDisplayScore, awayTeam, homeTeam)
    Row(
        modifier = Modifier
            .padding(top = AcornTheme.layout.space.static150)
            .fillMaxWidth()
            .clearAndSetSemantics {
                this.contentDescription = teamContentDescription
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Team(
            team = awayTeam,
            shouldDisplayScore = shouldDisplayScore,
            isAwayTeam = true,
            modifier = Modifier.weight(1f),
        )

        ScoreText(text = ":", modifier = Modifier.padding(horizontal = 16.dp))

        Team(
            team = homeTeam,
            shouldDisplayScore = shouldDisplayScore,
            isAwayTeam = false,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun getSportsIcon(sport: String): Painter? =
    when (sport) {
        "NBA", "CBB" -> painterResource(iconsR.drawable.mozac_ic_sports_basketball_32)
        "MLB" -> painterResource(iconsR.drawable.mozac_ic_sports_baseball_32)
        "NHL" -> painterResource(iconsR.drawable.mozac_ic_sports_hockey_32)
        "NFL", "CFB" -> painterResource(iconsR.drawable.mozac_ic_sports_american_football_32)
        "PGA" -> painterResource(iconsR.drawable.mozac_ic_sports_golf_32)
        "Bundesliga", "Ligue 1", "Serie A", "Champions League" ->
            painterResource(iconsR.drawable.mozac_ic_sports_european_football_32)
        else -> null
    }

@Composable
private fun getSportsDate(sportSuggestionDate: SportSuggestionDate): String =
    when (sportSuggestionDate) {
        is SportSuggestionDate.General -> sportSuggestionDate.date
        is SportSuggestionDate.Today -> stringResource(R.string.mozac_browser_awesomebar_sport_suggestion_date_today)
        is SportSuggestionDate.Tomorrow -> stringResource(
            R.string.mozac_browser_awesomebar_sport_suggestion_date_tomorrow,
            sportSuggestionDate.time,
        )
    }

@Composable
private fun getTeamContentDescription(
    shouldDisplayScore: Boolean,
    awayTeam: SportSuggestionTeam,
    homeTeam: SportSuggestionTeam,
) = if (shouldDisplayScore) {
    "${awayTeam.name}. ${awayTeam.score}. ${homeTeam.name}. ${homeTeam.score}"
} else {
    stringResource(
        R.string.mozac_browser_awesomebar_sport_suggestion_talkback_team_description_no_score,
        awayTeam.name,
        homeTeam.name,
    )
}

@Composable
private fun LiveStatus(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(
                color = MaterialTheme.colorScheme.success,
                shape = RoundedCornerShape(8.dp),
            )
            .clip(RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp),
    ) {
        Text(
            text = stringResource(R.string.mozac_browser_awesomebar_sport_suggestion_live),
            style = AcornTheme.typography.subtitle2,
            overflow = TextOverflow.Ellipsis,
            maxLines = 1,
            color = MaterialTheme.colorScheme.onPrimary,
        )
    }
}

@Composable
private fun Team(
    team: SportSuggestionTeam,
    shouldDisplayScore: Boolean,
    isAwayTeam: Boolean,
    modifier: Modifier = Modifier,
) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        if (shouldDisplayScore && !isAwayTeam) {
            ScoreText(text = "${team.score}", modifier = Modifier.padding(end = 24.dp))
        }
        Text(
            text = team.name,
            modifier = modifier,
            style = AcornTheme.typography.subtitle1,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
        if (shouldDisplayScore && isAwayTeam) {
            ScoreText(text = "${team.score}", modifier = Modifier.padding(start = 24.dp))
        }
    }
}

@Composable
private fun ScoreText(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        textAlign = TextAlign.Center,
        style = AcornTheme.typography.headline5,
        fontWeight = FontWeight.W700,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = modifier,
    )
}

@PreviewLightDark
@Composable
private fun SportSuggestionPreview(
    @PreviewParameter(SportSuggestionDataProvider::class) config: SportSuggestionPreviewModel,
) {
    AcornTheme {
        Surface {
            SportSuggestion(
                sport = config.sport,
                status = config.status,
                statusType = config.statusType,
                date = config.date,
                homeTeam = config.homeTeam,
                awayTeam = config.awayTeam,
                onClick = {},
            )
        }
    }
}

@Preview
@Composable
private fun SportSuggestionPreviewPrivate(
    @PreviewParameter(SportSuggestionDataProvider::class) config: SportSuggestionPreviewModel,
) {
    AcornTheme(
        colors = privateColorPalette,
        colorScheme = acornPrivateColorScheme(),
    ) {
        Surface {
            SportSuggestion(
                sport = config.sport,
                status = config.status,
                statusType = config.statusType,
                date = config.date,
                homeTeam = config.homeTeam,
                awayTeam = config.awayTeam,
                onClick = {},
            )
        }
    }
}
