; #106: register WebForge as a browser CANDIDATE so Windows 11 will offer it in
; Settings -> Default apps. Without these keys the HTTP/HTTPS picker has nothing
; to list for us, which is why only Store browsers showed up.
;
; This does NOT make WebForge the default — since Windows 10 the user must
; confirm the choice in Settings, and there is no legitimate way around that.
; All we can do is become selectable.
;
; HKCU throughout, matching the installer's own `perMachine: false`: a per-user
; install has no business writing machine-wide defaults.
;
; Lives at the location electron-builder looks in BY DEFAULT
; (<buildResources>/installer.nsh, i.e. windows/build/installer.nsh) rather than
; being wired up with nsis.include — that option's path is resolved relative to
; the build-resources dir, not the project dir, and getting it wrong fails
; silently: the installer builds fine and simply registers nothing.
;
; It is a BUILD resource, not app content, so it deliberately does not appear in
; build.files (see #65, where a file missing from that allowlist bricked startup).

!macro customInstall
  DetailPrint "Registering WebForge as a browser candidate"

  ; The ProgID every association below points at. "%1" is the URL or file path
  ; Windows hands us on the command line — main.js reads it out of process.argv.
  WriteRegStr HKCU "Software\Classes\WebForgeHTML" "" "WebForge Document"
  WriteRegStr HKCU "Software\Classes\WebForgeHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\WebForgeHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; The classic "I am a web browser" declaration. Windows reads Capabilities
  ; from here to decide what may appear in the HTTP/HTTPS picker.
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge" "" "WebForge"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities" "ApplicationName" "WebForge"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities" "ApplicationDescription" "WebForge — a custom browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities\URLAssociations" "http" "WebForgeHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities\URLAssociations" "https" "WebForgeHTML"
  ; .htm/.html are not optional decoration: the single "Set default" button in
  ; Windows 11 22H2+ sets http, https and both file types together, and only
  ; offers itself to apps that claim all four.
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities\FileAssociations" ".htm" "WebForgeHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\WebForge\Capabilities\FileAssociations" ".html" "WebForgeHTML"

  ; Until this exists, everything above is invisible to the Default apps UI.
  WriteRegStr HKCU "Software\RegisteredApplications" "WebForge" "Software\Clients\StartMenuInternet\WebForge\Capabilities"

  ; SHCNE_ASSOCCHANGED — tell the shell to re-read associations now rather than
  ; at next sign-in, so the app shows up without a reboot.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DetailPrint "Removing WebForge browser registration"
  DeleteRegKey HKCU "Software\Classes\WebForgeHTML"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\WebForge"
  DeleteRegValue HKCU "Software\RegisteredApplications" "WebForge"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
