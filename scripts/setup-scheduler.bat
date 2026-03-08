@echo off
echo Creating UniNotes hourly scheduled task...
schtasks /create /tn "UniNotes-LecturePipeline" /sc HOURLY /st 00:00 /tr "C:\Git\UniNotes\scripts\run.bat" /f
if %ERRORLEVEL% equ 0 (
    echo Task created successfully. The pipeline will run every hour starting at midnight.
    echo To view: schtasks /query /tn "UniNotes-LecturePipeline"
    echo To delete: schtasks /delete /tn "UniNotes-LecturePipeline" /f
) else (
    echo Failed to create scheduled task. Try running as Administrator.
)
pause
