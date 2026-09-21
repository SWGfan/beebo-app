@echo off
rem Re-make the "Hi, I'm <Name>." storybook voice samples in resources\voice-samples.
rem Needs Kokoro + soundfile (see electron\beebobook\SETUP-WINDOWS.md). Commit the results.
cd /d "%~dp0.."
py -3 tools\make-voice-samples.py %*
if errorlevel 1 (echo Voice samples FAILED. & pause & exit /b 1)
echo Done. Commit resources\voice-samples.
pause
