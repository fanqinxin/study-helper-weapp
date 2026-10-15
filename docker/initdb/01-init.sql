-- ============================================================
-- MySQL 容器首次初始化脚本
--
-- 注意：只有在数据卷为空（首次启动）时才会自动执行。
-- 项目表结构不在这里创建，由 `npm run migrate` / compose 的 migrate 服务负责，
-- 这样建表逻辑只有一份，避免两处维护产生漂移。
-- ============================================================

-- 库由 MYSQL_DATABASE 环境变量创建，这里再兜一层，确保字符集正确
CREATE DATABASE IF NOT EXISTS `study_helper`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- 应用账号已在入口脚本中创建并授权到 MYSQL_DATABASE；
-- 这里显式补一次全局授权，避免 DB_NAME 被改过时权限缺失
GRANT ALL PRIVILEGES ON `study_helper`.* TO 'study'@'%';

FLUSH PRIVILEGES;
