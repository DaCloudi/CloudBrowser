; Removes CloudBrowser's "web browser" registration from Windows when it is uninstalled
; (but not during an automatic update, which reinstalls straight away).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\CloudBrowserHTML"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\CloudBrowser"
    DeleteRegValue HKCU "Software\RegisteredApplications" "CloudBrowser"
  ${endIf}
!macroend
