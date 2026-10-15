-- ============================================================
-- 小学生同步学习小程序 · 数据库初始化
--
-- 执行方式：
--   1) 由 npm run migrate / 容器 migrate 服务执行（推荐，可重复运行）
--   2) 手工执行：mysql -u root -p < schema.sql
--
-- `__DB_NAME__` 是占位符，由 migrate.js 在执行前替换为实际库名（取 DB_NAME）。
-- 不要在这里写死库名：容器部署时应用账号通常无权 CREATE DATABASE，
-- 库已由 MySQL 容器（MYSQL_DATABASE）或运维提前创建，迁移只负责建表。
-- ============================================================

CREATE DATABASE IF NOT EXISTS `__DB_NAME__`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `__DB_NAME__`;

-- ------------------------------------------------------------
-- 家庭表：家长绑定关系的载体
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `family` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `invite_code` VARCHAR(12) NOT NULL UNIQUE COMMENT '家长扫码绑定码',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='家庭';

-- ------------------------------------------------------------
-- 用户表：孩子与家长统一存储，role 区分
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user` (
  `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
  `openid`          VARCHAR(64)  NOT NULL UNIQUE COMMENT '微信 openid',
  `unionid`         VARCHAR(64)  DEFAULT NULL,
  `role`            TINYINT      NOT NULL DEFAULT 1 COMMENT '1=孩子 2=家长',
  `nickname`        VARCHAR(64)  DEFAULT NULL,
  `avatar_url`      VARCHAR(512) DEFAULT NULL,
  `grade`           TINYINT      DEFAULT NULL COMMENT '年级 1-6',
  `family_id`       BIGINT       DEFAULT NULL,
  `textbook_id`     BIGINT       DEFAULT NULL COMMENT '当前教材',
  `lesson_progress` INT          NOT NULL DEFAULT 0 COMMENT '课堂进度：讲到第几课',
  `status`          TINYINT      NOT NULL DEFAULT 1 COMMENT '1=正常 0=已注销',
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_family (`family_id`),
  INDEX idx_role (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户';

-- ------------------------------------------------------------
-- 教材版本表
-- is_custom=1 为用户拍照上传的自定义教材
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `textbook` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name`       VARCHAR(64) NOT NULL COMMENT '如：人教版',
  `subject`    TINYINT     NOT NULL COMMENT '1=语文 2=数学 3=英语',
  `grade`      TINYINT     NOT NULL COMMENT '1-6',
  `volume`     TINYINT     NOT NULL COMMENT '1=上册 2=下册',
  `is_custom`  TINYINT     NOT NULL DEFAULT 0,
  `owner_uid`  BIGINT      DEFAULT NULL COMMENT '自定义教材归属用户',
  `status`     TINYINT     NOT NULL DEFAULT 1 COMMENT '0=识别中 1=可用 2=识别失败',
  `created_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_subject_grade (`subject`, `grade`, `volume`),
  INDEX idx_owner (`owner_uid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教材版本';

-- ------------------------------------------------------------
-- 课文/章节表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `lesson` (
  `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
  `textbook_id`      BIGINT       NOT NULL,
  `seq`              INT          NOT NULL COMMENT '第几课，用于对齐课堂进度',
  `title`            VARCHAR(128) NOT NULL,
  `unit`             VARCHAR(64)  DEFAULT NULL,
  `knowledge_points` JSON         DEFAULT NULL COMMENT '知识点标签数组',
  INDEX idx_textbook_seq (`textbook_id`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课文';

-- ------------------------------------------------------------
-- 题库表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `question` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `lesson_id`  BIGINT       NOT NULL,
  `type`       TINYINT      NOT NULL COMMENT '1=单选 2=填空 3=阅读理解 4=计算',
  `stem`       TEXT         NOT NULL,
  `options`    JSON         DEFAULT NULL,
  `answer`     VARCHAR(255) NOT NULL,
  `analysis`   TEXT         DEFAULT NULL,
  `difficulty` TINYINT      NOT NULL DEFAULT 2 COMMENT '1-3',
  INDEX idx_lesson (`lesson_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='题库';

-- ------------------------------------------------------------
-- 作业表
-- image_hash 唯一索引用于幂等，防止重复扣额度
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `homework` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `uid`         BIGINT       NOT NULL,
  `subject`     TINYINT      NOT NULL,
  `lesson_id`   BIGINT       DEFAULT NULL,
  `image_urls`  JSON         NOT NULL,
  `image_hash`  VARCHAR(64)  NOT NULL,
  `status`      TINYINT      NOT NULL DEFAULT 0 COMMENT '0=待处理 1=批改中 2=已完成 3=失败',
  `score`       INT          DEFAULT NULL,
  `total`       INT          DEFAULT NULL,
  `correct`     INT          DEFAULT NULL,
  `raw_result`  JSON         DEFAULT NULL COMMENT '模型原始返回，用于回溯调优',
  `error_msg`   VARCHAR(255) DEFAULT NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` DATETIME     DEFAULT NULL,
  INDEX idx_uid_time (`uid`, `created_at`),
  INDEX idx_status (`status`),
  UNIQUE KEY uk_uid_hash (`uid`, `image_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='作业';

-- ------------------------------------------------------------
-- 批改明细：逐题结果
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `homework_item` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `homework_id` BIGINT       NOT NULL,
  `seq`         INT          NOT NULL,
  `stem`        TEXT         DEFAULT NULL,
  `student_ans` VARCHAR(255) DEFAULT NULL,
  `correct_ans` VARCHAR(255) DEFAULT NULL,
  `is_correct`  TINYINT      DEFAULT NULL COMMENT '1=对 0=错 NULL=未判定',
  `analysis`    TEXT         DEFAULT NULL,
  INDEX idx_hw (`homework_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='批改明细';

-- ------------------------------------------------------------
-- 错题本
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `mistake` (
  `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
  `uid`              BIGINT       NOT NULL,
  `homework_item_id` BIGINT       NOT NULL,
  `subject`          TINYINT      NOT NULL,
  `knowledge_point`  VARCHAR(64)  DEFAULT NULL,
  `wrong_count`      INT          NOT NULL DEFAULT 1,
  `mastered`         TINYINT      NOT NULL DEFAULT 0,
  `last_wrong_at`    DATETIME     NOT NULL,
  INDEX idx_uid_subject (`uid`, `subject`, `mastered`),
  INDEX idx_kp (`knowledge_point`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='错题本';

-- ------------------------------------------------------------
-- 额度账户：一人一账户
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `quota_account` (
  `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
  `uid`          BIGINT   NOT NULL UNIQUE,
  `free_used`    INT      NOT NULL DEFAULT 0 COMMENT '本周期已用免费次数',
  `free_total`   INT      NOT NULL DEFAULT 20 COMMENT '免费额度（可配置）',
  `cycle_start`  DATE     NOT NULL COMMENT '本周期起始日',
  `paid_balance` INT      NOT NULL DEFAULT 0 COMMENT '加油包剩余次数',
  `monthly_until` DATETIME DEFAULT NULL COMMENT '月卡有效期，非空且未过期则不限次',
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='额度账户';

-- ------------------------------------------------------------
-- 额度流水：对账与排查必备
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `quota_log` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `uid`           BIGINT      NOT NULL,
  `change`        INT         NOT NULL COMMENT '正数=增加 负数=消耗',
  `source`        TINYINT     NOT NULL COMMENT '1=免费周期 2=购买 3=批改消耗 4=退款 5=后台调整',
  `ref_id`        VARCHAR(64) DEFAULT NULL COMMENT '关联订单号或作业ID',
  `balance_after` INT         NOT NULL,
  `remark`        VARCHAR(255) DEFAULT NULL,
  `created_at`    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uid_time (`uid`, `created_at`),
  INDEX idx_ref (`ref_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='额度流水';

-- ------------------------------------------------------------
-- 订单表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `order` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_no`      VARCHAR(32) NOT NULL UNIQUE,
  `uid`           BIGINT      NOT NULL,
  `pack_id`       VARCHAR(32) NOT NULL,
  `amount_fen`    INT         NOT NULL COMMENT '金额，单位分',
  `quota_granted` INT         NOT NULL DEFAULT 0,
  `is_monthly`    TINYINT     NOT NULL DEFAULT 0,
  `pay_status`    TINYINT     NOT NULL DEFAULT 0 COMMENT '0=待支付 1=已支付 2=已退款',
  `wx_trade_no`   VARCHAR(64) DEFAULT NULL,
  `paid_at`       DATETIME    DEFAULT NULL,
  `created_at`    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uid (`uid`, `created_at`),
  UNIQUE KEY uk_trade_no (`wx_trade_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单';

-- ------------------------------------------------------------
-- 学习计划任务
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `plan_task` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `uid`         BIGINT       NOT NULL,
  `plan_date`   DATE         NOT NULL,
  `title`       VARCHAR(128) NOT NULL,
  `type`        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=课文练习 2=错题巩固 3=作业批改 4=游戏',
  `ref_id`      BIGINT       DEFAULT NULL,
  `status`      TINYINT      NOT NULL DEFAULT 0 COMMENT '0=待完成 1=已完成',
  `finished_at` DATETIME     DEFAULT NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uid_date (`uid`, `plan_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学习计划任务';

-- ------------------------------------------------------------
-- 初始化：教材版本基础数据
-- ------------------------------------------------------------
INSERT IGNORE INTO `textbook` (`id`, `name`, `subject`, `grade`, `volume`) VALUES
  (1, '人教版', 1, 3, 1),
  (2, '苏教版', 1, 3, 1),
  (3, '北师大版', 1, 3, 1),
  (4, '人教PEP', 3, 3, 1);
