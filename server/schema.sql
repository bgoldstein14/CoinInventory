-- ============================================================
-- Coin Inventory Database Schema for SQL Server Express
-- ============================================================
-- Connection: localhost\SQLEXPRESS  (Windows Auth, no password)
-- Database:   CoinInventory
-- ============================================================

CREATE DATABASE CoinInventory;
GO

USE CoinInventory;
GO

-- ----- coins -------------------------------------------------
CREATE TABLE coins (
    id              NVARCHAR(36)    NOT NULL PRIMARY KEY,   -- UUID
    name            NVARCHAR(255)   NOT NULL,
    denomination    NVARCHAR(100)   NULL,
    year            INT             NULL,
    type            NVARCHAR(100)   NULL,
    category        NVARCHAR(100)   NULL,
    country         NVARCHAR(100)   NULL,
    grade           NVARCHAR(20)    NULL,
    cert_company    NVARCHAR(50)    NULL,
    cert_number     NVARCHAR(100)   NULL,
    variety         NVARCHAR(100)   NULL,
    mint_mark       NVARCHAR(10)    NULL,
    composition     NVARCHAR(100)   NULL,
    purchase_date   DATE            NULL,
    purchase_price  DECIMAL(12, 2)  NULL,
    current_value   DECIMAL(12, 2)  NULL,
    notes           NVARCHAR(MAX)   NULL,
    source          NVARCHAR(20)    NULL,           -- 'manual', 'quicken', 'csv', 'import'
    has_cac_sticker BIT             NOT NULL DEFAULT 0,
    sold_price      DECIMAL(12, 2)  NULL,
    sold_date       DATE            NULL,
    dealer          NVARCHAR(255)   NULL,
    weight          DECIMAL(10, 4)  NULL,           -- troy ounces
    metal_content   NVARCHAR(50)    NULL,           -- Gold, Silver, Platinum, etc.
    coin_set        NVARCHAR(255)   NULL
);

-- ----- coin_images -------------------------------------------
CREATE TABLE coin_images (
    id          INT             IDENTITY(1,1) PRIMARY KEY,
    coin_id     NVARCHAR(36)    NOT NULL,
    image_data  NVARCHAR(MAX)   NULL,               -- base64 data URL
    sort_order  INT             NOT NULL DEFAULT 0,
    CONSTRAINT FK_coin_images_coin
        FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE
);

-- ----- coin_tags ---------------------------------------------
CREATE TABLE coin_tags (
    coin_id     NVARCHAR(36)    NOT NULL,
    tag         NVARCHAR(100)   NOT NULL,
    CONSTRAINT PK_coin_tags PRIMARY KEY (coin_id, tag),
    CONSTRAINT FK_coin_tags_coin
        FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE
);

-- ----- categories --------------------------------------------
CREATE TABLE categories (
    name        NVARCHAR(100)   NOT NULL PRIMARY KEY
);

-- ----- coin_sets ---------------------------------------------
CREATE TABLE coin_sets (
    name        NVARCHAR(255)   NOT NULL PRIMARY KEY
);

-- ----- transactions ------------------------------------------
CREATE TABLE transactions (
    id          NVARCHAR(36)    NOT NULL PRIMARY KEY,   -- UUID
    coin_id     NVARCHAR(36)    NOT NULL,
    type        NVARCHAR(20)    NOT NULL,               -- purchase, sale, trade, appraisal
    date        DATE            NOT NULL,
    amount      DECIMAL(12, 2)  NOT NULL,
    dealer      NVARCHAR(255)   NULL,
    notes       NVARCHAR(MAX)   NULL,
    CONSTRAINT FK_transactions_coin
        FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE
);

-- ----- spot_prices -------------------------------------------
CREATE TABLE spot_prices (
    id          INT             IDENTITY(1,1) PRIMARY KEY,
    gold        DECIMAL(10, 2)  NOT NULL DEFAULT 0,
    silver      DECIMAL(10, 2)  NOT NULL DEFAULT 0,
    platinum    DECIMAL(10, 2)  NOT NULL DEFAULT 0,
    copper      DECIMAL(10, 4)  NOT NULL DEFAULT 0,
    source      NVARCHAR(100)   NULL,
    fetched_at  DATETIME2       NOT NULL DEFAULT GETDATE()
);

-- ----- app_settings ------------------------------------------
CREATE TABLE app_settings (
    setting_key     NVARCHAR(100)   NOT NULL PRIMARY KEY,
    setting_value   NVARCHAR(MAX)   NULL
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IX_coin_images_coin_id  ON coin_images (coin_id);
CREATE INDEX IX_coin_tags_coin_id    ON coin_tags   (coin_id);
CREATE INDEX IX_coins_category       ON coins       (category);
CREATE INDEX IX_coins_grade          ON coins       (grade);
CREATE INDEX IX_coins_year           ON coins       (year);
CREATE INDEX IX_coins_coin_set       ON coins       (coin_set);
CREATE INDEX IX_coins_dealer         ON coins       (dealer);
CREATE INDEX IX_coins_metal_content  ON coins       (metal_content);
CREATE INDEX IX_transactions_coin_id ON transactions (coin_id);

-- ============================================================
-- Migration helper: run this if you already have the old schema
-- and want to add the new columns without recreating the DB.
-- ============================================================
/*
USE CoinInventory;
GO

ALTER TABLE coins ADD sold_price    DECIMAL(12, 2) NULL;
ALTER TABLE coins ADD sold_date     DATE           NULL;
ALTER TABLE coins ADD dealer        NVARCHAR(255)  NULL;
ALTER TABLE coins ADD weight        DECIMAL(10, 4) NULL;
ALTER TABLE coins ADD metal_content NVARCHAR(50)   NULL;
ALTER TABLE coins ADD coin_set      NVARCHAR(255)  NULL;
GO

CREATE TABLE coin_sets (
    name NVARCHAR(255) NOT NULL PRIMARY KEY
);

CREATE TABLE transactions (
    id       NVARCHAR(36)   NOT NULL PRIMARY KEY,
    coin_id  NVARCHAR(36)   NOT NULL,
    type     NVARCHAR(20)   NOT NULL,
    date     DATE           NOT NULL,
    amount   DECIMAL(12, 2) NOT NULL,
    dealer   NVARCHAR(255)  NULL,
    notes    NVARCHAR(MAX)  NULL,
    CONSTRAINT FK_transactions_coin
        FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE
);

CREATE TABLE spot_prices (
    id         INT           IDENTITY(1,1) PRIMARY KEY,
    gold       DECIMAL(10,2) NOT NULL DEFAULT 0,
    silver     DECIMAL(10,2) NOT NULL DEFAULT 0,
    platinum   DECIMAL(10,2) NOT NULL DEFAULT 0,
    copper     DECIMAL(10,4) NOT NULL DEFAULT 0,
    source     NVARCHAR(100) NULL,
    fetched_at DATETIME2     NOT NULL DEFAULT GETDATE()
);

CREATE INDEX IX_coins_coin_set       ON coins (coin_set);
CREATE INDEX IX_coins_dealer         ON coins (dealer);
CREATE INDEX IX_coins_metal_content  ON coins (metal_content);
CREATE INDEX IX_transactions_coin_id ON transactions (coin_id);
GO
*/
