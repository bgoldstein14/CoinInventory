-- ############################################################
-- ##                                                        ##
-- ##   LEGACY. THE APPLICATION NO LONGER USES SQL SERVER.   ##
-- ##                                                        ##
-- ############################################################
--
-- The application runs on SQLite (design §4.1) and needs no login, no
-- instance and no authentication mode: the database is a file under
-- %LOCALAPPDATA%\CoinInventory, opened by the process that owns it.
--
-- This script is kept for the same reason as setup-database.sql: the
-- owner's own collection is still in SQL Server, and Stage 2's one-time
-- import has to be able to log in to it. It goes with that file, with
-- `mssql` and with `msnodesqlv8`, once he has confirmed his data has moved.
--
-- Do not run it on a new install. There is nothing for it to configure.

USE master;
GO

-- Enable mixed-mode auth (SQL + Windows)
EXEC xp_instance_regwrite N'HKEY_LOCAL_MACHINE',
  N'Software\Microsoft\MSSQLServer\MSSQLServer',
  N'LoginMode', REG_DWORD, 2;
GO

-- Create a login for the app
CREATE LOGIN CoinApp WITH PASSWORD = '<choose-a-strong-password>';
GO

USE CoinInventory;
GO

CREATE USER CoinApp FOR LOGIN CoinApp;
GO

ALTER ROLE db_owner ADD MEMBER CoinApp;
GO
