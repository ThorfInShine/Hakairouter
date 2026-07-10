@echo off
title 9router - Next.js App Manager

:menu
cls
echo =================================================
echo         9router - Next.js App Manager
echo =================================================
echo 1. Nyalakan Aplikasi (Start)
echo 2. Matikan Aplikasi (Stop)
echo 3. Keluar
echo =================================================
set /p pilihan="Pilih menu (1/2/3): "

if "%pilihan%"=="1" goto start_app
if "%pilihan%"=="2" goto stop_app
if "%pilihan%"=="3" goto exit_app

:: Jika input tidak valid
echo.
echo Pilihan tidak valid! Silakan masukkan angka 1, 2, atau 3.
pause
goto menu

:start_app
echo.
echo Menyalakan server Next.js di jendela baru...
:: Mengubah cmd /k menjadi cmd /c agar jendela otomatis tertutup saat proses dimatikan
start "9router Server" cmd /c "cd /d C:\Users\Bangsawan\Documents\Codingan\9router && call conda activate base && set PORT=20128 && set HOSTNAME=0.0.0.0 && set NEXT_PUBLIC_BASE_URL=http://localhost:20128 && npm run start"
echo Server berhasil dijalankan.
timeout /t 2 >nul
goto menu

:stop_app
echo.
echo Mencari dan mematikan proses di port 20128...
set "ditemukan="

:: Mencari dan mematikan proses berdasarkan port 20128
FOR /F "tokens=5" %%a IN ('netstat -aon ^| findstr :20128') DO (
    if not "%%a"=="0" (
        :: Menambahkan >nul 2>&1 agar tampilan layar tetap bersih dari pesan error berulang
        taskkill /F /PID %%a >nul 2>&1
        set "ditemukan=1"
    )
)

if not defined ditemukan (
    echo Tidak ada aplikasi yang berjalan di port 20128.
) else (
    echo Aplikasi beserta jendelanya berhasil dimatikan secara bersih.
)
echo.
pause
goto menu

:exit_app
exit