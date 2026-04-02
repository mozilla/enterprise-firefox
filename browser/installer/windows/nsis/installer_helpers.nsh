# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

!ifndef INSTALLER_HELPERS_NSH
!define INSTALLER_HELPERS_NSH

!include control_utils.nsh

; For new installs, install desktop launcher
; TODO: This case needs more nuance. To be fixed as part of Bug 1981597
Function OnInstallDesktopLauncherHandler
  Push $0
  ${SwapShellVarContext} current $0
  Call InstallDesktopLauncher
  ${SetShellVarContextToValue} $0
  Pop $0
FunctionEnd

!macro GetExistingInstallPath Result
  !ifdef HAVE_64BIT_BUILD
    ${GetExistingInstallPathFromRegView} 64 ${Result}
    ${If} ${Result} == ""
      ${GetExistingInstallPathFromRegView} 32 ${Result}
    ${EndIf}
  !else
    ${GetExistingInstallPathFromRegView} 32 ${Result}
    ${If} ${Result} == ""

      ; Only check the 64-bit registry if the native OS is 64-bit
      ; On a native 32-bit OS there is no 64-bit registry view to fall back to
      ${If} ${IsNativeAMD64}
      ${OrIf} ${IsNativeARM64}
        ${GetExistingInstallPathFromRegView} 64 ${Result}
      ${EndIf}
    ${EndIf}
  !endif
!macroend
!define GetExistingInstallPath "!insertmacro GetExistingInstallPath"

!macro GetExistingInstallPathFromRegView RegView Result
  SetRegView ${RegView}
  ${GetExistingInstallPathFromAnyShellVarContext} ${Result}
  SetRegView lastused
!macroend
!define GetExistingInstallPathFromRegView "!insertmacro GetExistingInstallPathFromRegView"

!macro GetExistingInstallPathFromAnyShellVarContext Result
  ${GetExistingInstallPathFromShellVarContext} all ${Result}
  ${If} ${Result} == ""
    ${GetExistingInstallPathFromShellVarContext} current ${Result}
  ${EndIf}
!macroend
!define GetExistingInstallPathFromAnyShellVarContext "!insertmacro GetExistingInstallPathFromAnyShellVarContext"

!macro GetExistingInstallPathFromShellVarContext ShellVarContext Result
  SetShellVarContext ${ShellVarContext}
  ${GetFirstInstallPath} "Software\Mozilla\${BrandFullNameInternal}" ${Result}
  ${If} ${Result} == "false"
    StrCpy ${Result} ""
  ${EndIf}
!macroend
!define GetExistingInstallPathFromShellVarContext "!insertmacro GetExistingInstallPathFromShellVarContext"

!macro UseExistingInstallPathIfNoParam Path
  ${GetInstallDirectoryPathParam} $R0
  ${If} "$R0" == ""
    ${GetInstallDirectoryNameParam} $R0
    ${If} "$R0" == ""
      StrCpy $INSTDIR "${Path}"
    ${EndIf}
  ${EndIf}
!macroend
!define UseExistingInstallPathIfNoParam "!insertmacro UseExistingInstallPathIfNoParam"

!macro GetInstallDirectoryPathParam Result
  Push $R0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} "$R0" "/InstallDirectoryPath=" ${Result}
  ${If} ${Errors}
    StrCpy ${Result} ""
  ${EndIf}
  Pop $R0
!macroend
!define GetInstallDirectoryPathParam "!insertmacro GetInstallDirectoryPathParam"

!macro GetInstallDirectoryNameParam Result
  Push $R0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} "$R0" "/InstallDirectoryName=" ${Result}
  ${If} ${Errors}
    StrCpy ${Result} ""
  ${EndIf}
  Pop $R0
!macroend
!define GetInstallDirectoryNameParam "!insertmacro GetInstallDirectoryNameParam"

!endif
