# 环境搭建指南

## 前置依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| Python | 3.10+ | 训练脚本运行 |
| Node.js | 18+ | Web 服务运行 |
| MySQL | 8.0+ | 数据持久化 |

---

## 1. MySQL 安装与配置

### macOS
```bash
brew install mysql
brew services start mysql
```

### 设置 root 密码
```bash
# 首次安装后设置密码
mysql -u root -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '你的密码';"
```

### 创建数据库
```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS skillopt CHARACTER SET utf8mb4;"
```

### 环境变量（可选，默认值在代码中）
```bash
# 默认值：host=127.0.0.1, port=3306, user=root, password='', database=skillopt
# 如需自定义：
export MYSQL_HOST=127.0.0.1
export MYSQL_PORT=3306
export MYSQL_USER=root
export MYSQL_PASSWORD=你的密码
export MYSQL_DATABASE=skillopt
```

---

## 2. Python 环境

### 创建虚拟环境
```bash
cd skillopt-engine
python3 -m venv venv
source venv/bin/activate
```

### 安装依赖
```bash
pip install -r requirements.txt
```

### 依赖清单
```
openai>=1.30.0      # AI 后端调用
pyyaml>=6.0         # 配置文件解析
numpy>=1.24.0       # 数值计算
openpyxl>=3.1.0     # Excel 文件处理
azure-identity      # Azure 认证
azure-core          # Azure 核心
httpx>=0.27.0       # HTTP 客户端
```

---

## 3. Node.js 环境

```bash
cd web
npm install
```

---

## 4. API Key 配置

### 方式一：Web 界面配置（推荐）

启动后在「设置」页面填写：
- **DeepSeek**: Base URL + API Key
- **Azure OpenAI**: Endpoint + API Key + Version
- **OpenAI**: API Key

### 方式二：环境变量

```bash
# DeepSeek
export OPENAI_COMPAT_BASE_URL="https://api.deepseek.com/v1"
export OPENAI_COMPAT_API_KEY="sk-xxx"

# Azure OpenAI
export AZURE_OPENAI_ENDPOINT="https://xxx.openai.azure.com"
export AZURE_OPENAI_API_KEY="xxx"
export AZURE_OPENAI_API_VERSION="2024-02-01"

# OpenAI
export OPENAI_API_KEY="sk-xxx"
```

---

## 5. 启动项目

### 启动后端
```bash
cd skillopt-engine
npx tsx web/server/src/index.ts
# 监听 http://localhost:3002
```

### 启动前端
```bash
cd skillopt-engine/web
npx vite --port 5173
# 监听 http://localhost:5173
```

### 打开浏览器
```
http://localhost:5173
```

---

## 6. 数据库表结构

首次启动时自动创建以下表：

| 表名 | 说明 |
|------|------|
| `users` | 用户账号 |
| `api_keys` | API Key 存储 |
| `training_runs` | 训练运行记录 |
| `training_data_items` | 训练数据 |
| `training_logs` | 训练日志 |
| `skill_versions` | 技能版本 |
| `step_history` | 训练步骤历史 |
| `evaluation_details` | 评估详情 |
| `user_skills` | 用户技能 |
| `templates` | 训练模板 |

---

## 7. 项目结构

```
skillopt-engine/
├── skillopt/              # ReflACT 训练框架
│   ├── engine/trainer.py  # 主训练器
│   ├── envs/              # 基准测试环境
│   ├── model/             # AI 后端适配
│   ├── gradient/          # 梯度计算
│   ├── optimizer/         # 优化器
│   └── evaluation/        # 验证门控
├── web/                   # 全栈 Web
│   ├── src/pages/         # 前端页面
│   └── server/src/        # 后端服务
├── configs/               # 训练配置 YAML
├── scripts/train.py       # 训练入口脚本
├── requirements.txt       # Python 依赖
└── SETUP.md               # 本文件
```

---

## 8. 常见问题

### Q: `Failed to fetch`
后端挂了，重新启动 `npx tsx web/server/src/index.ts`

### Q: 训练报错 `No such file: train.py`
确保在项目根目录启动后端

### Q: 数据库连接失败
检查 MySQL 是否运行：`brew services list | grep mysql`
