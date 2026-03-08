@echo off
cd /d C:\Git\UniNotes
npx tsx src\main.ts >> logs\scheduler-%date:~-4,4%%date:~-10,2%%date:~-7,2%.log 2>&1
