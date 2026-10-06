!macro customUnInstall
  IfFileExists "$APPDATA\ERPNext Desktop\instances\default\compose.yaml" 0 askUserData
  IfFileExists "$PROGRAMFILES64\Docker\Docker\resources\bin\docker.exe" 0 askUserData
  ExecWait '"$PROGRAMFILES64\Docker\Docker\resources\bin\docker.exe" compose -f "$APPDATA\ERPNext Desktop\instances\default\compose.yaml" down --remove-orphans'
  askUserData:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Keep your ERPNext database and files for a future reinstall? Choose No to permanently remove the Docker volumes and local workspace." \
    IDYES keepUserData
  IfFileExists "$PROGRAMFILES64\Docker\Docker\resources\bin\docker.exe" 0 removeUserData
  IfFileExists "$APPDATA\ERPNext Desktop\instances\default\compose.yaml" 0 removeUserData
  ExecWait '"$PROGRAMFILES64\Docker\Docker\resources\bin\docker.exe" compose -f "$APPDATA\ERPNext Desktop\instances\default\compose.yaml" down --remove-orphans --volumes --rmi local'
  removeUserData:
  RMDir /r "$APPDATA\ERPNext Desktop"
  keepUserData:
!macroend
