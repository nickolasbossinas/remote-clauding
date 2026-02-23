@echo off
echo Starting build... > C:\Users\nicko\tauri_output.txt
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >> C:\Users\nicko\tauri_output.txt 2>&1
set PATH=C:\Program Files\Rust stable MSVC 1.93\bin;%PATH%
cd /d C:\Users\nicko\Documents\RemoteClauding\git\remote-clauding\tauri-app
echo Running tauri build... >> C:\Users\nicko\tauri_output.txt
npx tauri build >> C:\Users\nicko\tauri_output.txt 2>&1
echo DONE=%ERRORLEVEL% >> C:\Users\nicko\tauri_output.txt
