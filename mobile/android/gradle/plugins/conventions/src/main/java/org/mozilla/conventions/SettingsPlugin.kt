/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.conventions

import org.gradle.api.Plugin
import org.gradle.api.initialization.Settings
import org.gradle.api.initialization.resolve.RepositoriesMode

class SettingsPlugin : Plugin<Settings> {
    override fun apply(settings: Settings) {
        configureDependencyResolution(settings)

        settings.gradle.allprojects {
            pluginManager.apply(ProjectPlugin::class.java)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun configureDependencyResolution(settings: Settings) {
        val mozconfig = settings.gradle.extensions.extraProperties["mozconfig"] as Map<String, Any>
        val topobjdir = mozconfig["topobjdir"] as String
        val configureMavenRepositories = settings.gradle.extensions.extraProperties["configureMavenRepositories"] as groovy.lang.Closure<*>

        settings.dependencyResolutionManagement {
            repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
            repositories {
                configureMavenRepositories.call(this)
                maven { setUrl("${topobjdir}/gradle/maven") }
            }
        }
    }
}
