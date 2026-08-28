USE master;
GO

-- Enable mixed-mode auth (SQL + Windows)
EXEC xp_instance_regwrite N'HKEY_LOCAL_MACHINE',
  N'Software\Microsoft\MSSQLServer\MSSQLServer',
  N'LoginMode', REG_DWORD, 2;
GO

-- Create a login for the app
CREATE LOGIN CoinApp WITH PASSWORD = 'CoinInv2024!';
GO

USE CoinInventory;
GO

CREATE USER CoinApp FOR LOGIN CoinApp;
GO

ALTER ROLE db_owner ADD MEMBER CoinApp;
GO
