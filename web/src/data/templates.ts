export interface SkillTemplate {
  id: string
  name: string
  category: 'analysis' | 'computation' | 'reasoning' | 'comprehensive'
  categoryLabel: string
  difficulty: 'medium' | 'hard'
  description: string
  icon: string
  env: string
  skillContent: string
  trainQa: Array<{ question: string; answers: string[] }>
  valQa: Array<{ question: string; answers: string[] }>
  expectedMetrics: {
    baselineAccuracy: string
    optimizedAccuracy: string
    avgSteps: number
    avgPatchesPerStep: number
    accuracyGain: string
  }
  highlights: string[]
  splitRatio: number   // 训练/验证拆分比例，默认 0.8（80%训练，20%验证）
  config: {
    epochs: number
    batchSize: number
    editBudget: number
    lrScheduler: string
    gateMetric: string
    analystWorkers: number
  }
}

export const TEMPLATES: SkillTemplate[] = [
  // ════════════════════════════════════════════════════════════════
  // 1. 代码问题分类器（初始skill极度简化）
  // ════════════════════════════════════════════════════════════════
  {
    id: 'code-review',
    name: '代码问题分类器',
    category: 'analysis',
    categoryLabel: '分析类',
    difficulty: 'medium',
    description: '快速识别代码中的问题类型：安全漏洞、性能瓶颈、逻辑错误、代码异味',
    icon: '🔍',
    env: 'searchqa',
    highlights: [
      '识别安全漏洞、性能问题、逻辑错误、代码异味',
      '识别并发问题、竞态条件等复杂问题',
      '初始skill极度简化：只会说"有问题"',
      '验证集包含高级问题类型，优化空间巨大',
    ],
    expectedMetrics: {
      baselineAccuracy: '10%',
      optimizedAccuracy: '85%',
      avgSteps: 6,
      avgPatchesPerStep: 2,
      accuracyGain: '+75%',
    },
    splitRatio: 0.8,
    config: {
      epochs: 6,
      batchSize: 10,
      editBudget: 6,
      lrScheduler: 'cosine',
      gateMetric: 'soft',
      analystWorkers: 8,
    },
    skillContent: `# 代码问题分类 Skill

## 角色
你是一位初级代码审查员，正在学习识别代码问题。

## 输出格式
只输出问题类型名称，不要解释。`,
    trainQa: [
      { question: `def get_user(username):
    cursor.execute(f"SELECT * FROM users WHERE name = '{username}'")`, answers: ['安全问题'] },
      { question: `def find_dups(items):
    for i in range(len(items)):
        if items[i] in items[i+1:]:
            result.append(items[i])`, answers: ['性能问题'] },
      { question: `app.get('/api/file', (req, res) => {
    const filename = req.query.name;
    const content = fs.readFileSync('./uploads/' + filename, 'utf8');
});`, answers: ['安全问题'] },
      { question: `def process(data):
    result = {}
    for item in data:
        key = item['name']
        result[key] = data.count(item)`, answers: ['性能问题'] },
      { question: `for (var i = 0; i < 5; i++) {
    btn.onclick = function() { alert(i); };
}`, answers: ['逻辑问题'] },
      { question: `hashed = hashlib.md5(user_input.encode()).hexdigest()
if hashed == stored_hash: return True`, answers: ['安全问题'] },
      { question: `function formatPrice(price) {
    if (price) { return '¥' + price.toFixed(2); }
    return '价格未设定';
}`, answers: ['逻辑问题'] },
      { question: `def fibonacci(n):
    if n <= 1: return n
    return fibonacci(n-1) + fibonacci(n-2)`, answers: ['性能问题'] },
      { question: `try:
    with open(path) as f: return json.load(f)
except:
    return {}`, answers: ['逻辑问题'] },
      { question: `for user in users:
    user_orders = [o for o in orders if o['user_id'] == user['id']]`, answers: ['性能问题'] },
      { question: `const cache = {};
function getData(key) { ... cache[key] = data; }`, answers: ['逻辑问题'] },
      { question: `exec('convert ' + file + ' -format ' + format, callback)`, answers: ['安全问题'] },
    ],
    valQa: [
      { question: `def get_user(user_id):
    user = db.query(f"SELECT * FROM users WHERE id = {user_id}")
    return user`, answers: ['SQL注入'] },
      { question: `for i in range(1000000):
    with open('file.txt', 'a') as f:
        f.write('line\\n')`, answers: ['循环内文件IO'] },
      { question: `function App() {
    const [data, setData] = useState([]);
    useEffect(() => {
        setData(fetchData());
    });
    return <List data={data} />;
}`, answers: ['无限循环更新'] },
      { question: `def calculate(n):
    if n == 0: return 1
    return n * calculate(n)`, answers: ['递归无法终止'] },
      { question: `SELECT * FROM orders WHERE id IN (
    SELECT order_id FROM items WHERE quantity > 0
) AND status = 'shipped'`, answers: ['子查询嵌套'] },
    ],
  },

  // ════════════════════════════════════════════════════════════════
  // 2. SQL性能问题识别器（初始skill极度简化）
  // ════════════════════════════════════════════════════════════════
  {
    id: 'sql-optimizer',
    name: 'SQL性能问题识别器',
    category: 'computation',
    categoryLabel: '计算类',
    difficulty: 'medium',
    description: '快速识别 SQL 查询中的性能问题类型：全表扫描、索引失效、N+1查询、子查询等',
    icon: '⚡',
    env: 'searchqa',
    highlights: [
      '识别全表扫描、函数包裹列、隐式类型转换',
      '识别子查询、N+1问题、排序瓶颈',
      '初始skill极度简化：只会说"需要优化"',
      '验证集包含高级SQL问题，优化空间巨大',
    ],
    expectedMetrics: {
      baselineAccuracy: '10%',
      optimizedAccuracy: '88%',
      avgSteps: 6,
      avgPatchesPerStep: 2,
      accuracyGain: '+78%',
    },
    splitRatio: 0.8,
    config: {
      epochs: 7,
      batchSize: 12,
      editBudget: 8,
      lrScheduler: 'cosine',
      gateMetric: 'soft',
      analystWorkers: 8,
    },
    skillContent: `# SQL 性能问题识别 Skill

## 角色
你是一位初级 SQL 性能分析师，正在学习识别常见性能问题。

## 输出格式
只输出问题类型名称，不要解释。`,
    trainQa: [
      { question: `SELECT u.name, (SELECT SUM(o.amount) FROM orders o WHERE o.user_id = u.id) AS total
FROM users u WHERE u.status = 'active';`, answers: ['关联问题'] },
      { question: `SELECT * FROM products
WHERE category_id IN (SELECT id FROM categories WHERE active = 1);`, answers: ['关联问题'] },
      { question: `SELECT COUNT(*) FROM logs WHERE YEAR(created_at) = 2024;`, answers: ['索引失效'] },
      { question: `SELECT DATE(order_date) AS day, COUNT(*) AS orders
FROM orders WHERE order_date >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY day;`, answers: ['索引失效'] },
      { question: `SELECT * FROM products
WHERE LOWER(name) LIKE '%phone%'
ORDER BY created_at DESC LIMIT 20;`, answers: ['索引失效'] },
      { question: `SELECT * FROM articles
WHERE status = 'published'
ORDER BY published_at DESC
LIMIT 20 OFFSET 100000;`, answers: ['慢查询'] },
      { question: `SELECT o.*, p.name, c.email
FROM orders o
JOIN products p ON o.product_id = p.id
JOIN customers c ON o.customer_id = c.id
WHERE o.created_at > '2024-01-01';`, answers: ['关联问题'] },
      { question: `SELECT * FROM small_table s, large_table l
WHERE s.id = l.id AND s.type = 'A';`, answers: ['关联问题'] },
      { question: `SELECT category_id, COUNT(*) AS cnt, AVG(price) AS avg_price
FROM products GROUP BY category_id HAVING cnt > 10;`, answers: ['慢查询'] },
      { question: `SELECT u.name, COUNT(o.id), SUM(o.amount)
FROM users u LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name ORDER BY SUM(o.amount) DESC;`, answers: ['慢查询'] },
      { question: `SELECT * FROM products WHERE category = 'electronics'
ORDER BY price ASC, rating DESC, created_at DESC LIMIT 20;`, answers: ['慢查询'] },
      { question: `SELECT * FROM users
WHERE email = 'test@example.com' OR phone = '13800138000';`, answers: ['索引失效'] },
      { question: `SELECT * FROM employees
WHERE department = 'Engineering' OR salary > 100000;`, answers: ['索引失效'] },
      { question: `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1;
-- 对每个用户循环执行`, answers: ['慢查询'] },
      { question: `DELETE FROM logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);`, answers: ['慢查询'] },
      { question: `UPDATE orders SET status = 'expired'
WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);`, answers: ['慢查询'] },
      { question: `SELECT * FROM products WHERE description LIKE '%discount%';`, answers: ['索引失效'] },
      { question: `SELECT * FROM active_user_orders WHERE cnt > 5;
-- active_user_orders 是一个视图`, answers: ['慢查询'] },
      { question: `SELECT DISTINCT category FROM products ORDER BY created_at DESC LIMIT 10;`, answers: ['慢查询'] },
      { question: `SELECT * FROM users WHERE phone = 13800138000;
-- phone列是VARCHAR类型`, answers: ['索引失效'] },
    ],
    valQa: [
      { question: `SELECT * FROM products ORDER BY RAND() LIMIT 5;
# 找出这个查询的性能问题`, answers: ['ORDER BY RAND导致全表扫描'] },
      { question: `SELECT COUNT(*) FROM orders WHERE DATE(created_at) = '2024-06-01';
# DATE函数对索引有什么影响？`, answers: ['函数包裹导致索引失效'] },
      { question: `SELECT * FROM articles WHERE title LIKE '%新闻%';
# 这个查询能使用索引吗？`, answers: ['前导通配符无法使用索引'] },
      { question: `SELECT p.*, (SELECT AVG(r.rating) FROM reviews r WHERE r.product_id = p.id) AS avg_rating
FROM products p;
# 子查询有什么性能问题？`, answers: ['相关子查询每行执行一次'] },
      { question: `SELECT * FROM v_active_users WHERE login_count > 100;
# v_active_users是视图，分析这个查询的性能
`, answers: ['视图嵌套导致重复计算'] },
      { question: `SELECT department, COUNT(*) FROM employees
GROUP BY department
HAVING COUNT(*) > 5
ORDER BY COUNT(*) DESC;
# 这个查询有什么性能问题？`, answers: ['GROUP BY + ORDER BY导致临时表'] },
      { question: `SELECT * FROM orders
WHERE YEAR(order_date) = 2024 AND MONTH(order_date) = 6;
# 这个查询的性能问题是什么？`, answers: ['函数包裹索引列导致全表扫描'] },
      { question: `SELECT o.id, o.total,
    (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
FROM orders o;
# 这个查询有什么性能问题？`, answers: ['N+1查询问题'] },
      { question: `SELECT * FROM logs
WHERE status = 'error'
ORDER BY created_at DESC
LIMIT 100;
# 假设logs表有1000万条数据，这个查询的问题？`, answers: ['LIMIT偏移量过大的性能问题'] },
      { question: `UPDATE users SET last_login = NOW() WHERE id = 1;
# 这是一条简单的更新，有什么问题吗？`, answers: ['更新语句无WHERE条件（全表更新）'] },
    ],
  },

  // ════════════════════════════════════════════════════════════════
  // 3. 逻辑谬误分类器（初始skill极度简化）
  // ════════════════════════════════════════════════════════════════
  {
    id: 'fallacy-detector',
    name: '逻辑谬误分类器',
    category: 'reasoning',
    categoryLabel: '推理类',
    difficulty: 'medium',
    description: '快速识别论证中的逻辑谬误类型：诉诸人身、假两难、滑坡论证、稻草人等',
    icon: '🧠',
    env: 'searchqa',
    highlights: [
      '识别多种高级逻辑谬误',
      '区分复杂的因果谬误类型',
      '初始skill极度简化：只会说"有道理"',
      '验证集包含复杂谬误，优化空间巨大',
    ],
    expectedMetrics: {
      baselineAccuracy: '10%',
      optimizedAccuracy: '82%',
      avgSteps: 6,
      avgPatchesPerStep: 2,
      accuracyGain: '+72%',
    },
    splitRatio: 0.8,
    config: {
      epochs: 7,
      batchSize: 10,
      editBudget: 6,
      lrScheduler: 'cosine',
      gateMetric: 'soft',
      analystWorkers: 8,
    },
    skillContent: `# 逻辑谬误分类 Skill

## 角色
你是一位逻辑分析初学者，正在学习识别常见逻辑错误。

## 输出格式
只输出谬误类型名称，不要解释。`,
    trainQa: [
      { question: `"我对手上的私立学校，有什么资格谈论公立教育？"`, answers: ['人身攻击'] },
      { question: `"他连自己生活都管不好，政治主张怎么能靠谱？"`, answers: ['人身攻击'] },
      { question: `"你要么支持提案，要么就是希望公司失败。"`, answers: ['虚假二分'] },
      { question: `"既然你不能100%证明疫苗安全，那接种疫苗就是赌博。"`, answers: ['虚假二分'] },
      { question: `"降低录取标准→教育质量下降→社会竞争力受损→经济崩溃→国家衰落"`, answers: ['过度概括'] },
      { question: `"今天允许同性婚姻，明天就会允许人与动物结婚，后天社会就崩溃了。"`, answers: ['过度概括'] },
      { question: `"环保主义者说我们应该减少碳排放？他们就是想让我们回到原始社会住山洞！"`, answers: ['人身攻击'] },
      { question: `"反对全民医保的人就是想让穷人看不起病死掉。"`, answers: ['人身攻击'] },
      { question: `"专家说这投资最好，哈佛毕业的，你应该投。"`, answers: ['过度概括'] },
      { question: `"张教授是诺贝尔奖得主，他说外星人存在，所以外星人一定存在。"`, answers: ['过度概括'] },
      { question: `"科学家对气候变化意见不统一，我们还不该行动。"`, answers: ['过度概括'] },
      { question: `"大家都在用这个App，你怎么能不用呢？"`, answers: ['过度概括'] },
      { question: `"我采访了20位朋友，15位说新手机好，所以75%消费者都喜欢。"`, answers: ['过度概括'] },
      { question: `"你说吸烟有害健康？我爷爷一天两包活到95岁！"`, answers: ['过度概括'] },
      { question: `"我们的新药一定有效，因为临床试验中95%患者症状改善了。"`, answers: ['因果错误'] },
      { question: `"爱因斯坦是素食者且是天才，所以素食有助于智力发展。"`, answers: ['因果错误'] },
      { question: `"冰淇淋销量上升时溺水死亡也上升，所以冰淇淋导致溺水。"`, answers: ['因果错误'] },
      { question: `"早上喝咖啡的人心脏病发病率更高，所以咖啡可能导致心脏病。"`, answers: ['因果错误'] },
      { question: `"比尔·盖茨大学辍学成了首富，所以我也不需要读完大学。"`, answers: ['过度概括'] },
      { question: `"我看过所有成功创业者都说要敢于冒险，所以冒险就是成功之道。"`, answers: ['过度概括'] },
    ],
    valQa: [
      { question: `"你不喜欢这电影？你没品味。我有电影学学位，我懂。"`, answers: ['诉诸权威：利用专业身份而非论证'] },
      { question: `"如果我们在移民问题上让步，下一步他们就会要求开放全部边境。"`, answers: ['滑坡论证：无根据的极端推演'] },
      { question: `"你说我方案有问题？你连项目都没参与过，凭什么批评？"`, answers: ['诉诸人身：攻击提出者而非论点'] },
      { question: `"90%的用户给了五星好评，所以这产品一定是最好的。"`, answers: ['诉诸群众：多数不等于正确'] },
      { question: `"股市上涨那天我穿了红袜子，所以红袜子能带来好运。"`, answers: ['后此谬误：时间先后不等于因果'] },
      { question: `"吸烟的人肺癌发病率高，所以吸烟会导致肺癌。"`, answers: ['因果推断：共变不等于因果'] },
      { question: `"我周围的朋友都离婚了，所以婚姻制度有问题。"`, answers: ['以偏概全：样本不代表全体'] },
      { question: `"如果你不支持我们的政策，就是反对国家安全。"`, answers: ['虚假二分：非此即彼的强迫选择'] },
      { question: `"历史上所有伟大的科学家都相信上帝，所以上帝存在。"`, answers: ['诉诸权威：权威不等于真理'] },
      { question: `"这东西便宜没好货，一分钱一分货嘛。"`, answers: ['过度概括：价格不等于质量'] },
    ],
  },

  // ════════════════════════════════════════════════════════════════
  // 4. 证明正误判断器（初始skill极度简化）
  // ════════════════════════════════════════════════════════════════
  {
    id: 'math-proof-evaluator',
    name: '证明正误判断器',
    category: 'comprehensive',
    categoryLabel: '综合类',
    difficulty: 'medium',
    description: '判断数学证明是否正确，识别常见证明错误类型：除以零、以偏概全、循环论证等',
    icon: '📐',
    env: 'searchqa',
    highlights: [
      '判断证明正确/错误/有小缺陷',
      '识别除以零、以偏概全、代数错误',
      '初始skill极度简化：只会说"对了"',
      '验证集包含复杂证明问题，优化空间巨大',
    ],
    expectedMetrics: {
      baselineAccuracy: '10%',
      optimizedAccuracy: '90%',
      avgSteps: 6,
      avgPatchesPerStep: 2,
      accuracyGain: '+80%',
    },
    splitRatio: 0.8,
    config: {
      epochs: 7,
      batchSize: 8,
      editBudget: 6,
      lrScheduler: 'cosine',
      gateMetric: 'soft',
      analystWorkers: 8,
    },
    skillContent: `# 证明正误判断 Skill

## 角色
你是一位数学证明初学者，正在学习判断证明是否正确。

## 输出格式
只输出判断结果，不要解释。`,
    trainQa: [
      { question: `证明√2是无理数：假设√2=a/b互质，两边平方得a²=2b²，a为偶→a=2k→2k²=b²→b为偶，与互质矛盾。`, answers: ['正确'] },
      { question: `证明n²+n+41是质数：n=0→41质数，n=1→43质数，n=2→47质数，所以对所有n成立。`, answers: ['错误'] },
      { question: `证明lim(1+1/n)^n=e：取对数ln(a_n)=n·ln(1+1/n)~n·(1/n)=1，所以lim a_n=e。`, answers: ['有缺陷'] },
      { question: `证明1=2：令a=b，a²=ab，a²-b²=ab-b²，(a-b)(a+b)=b(a-b)，除以a-b得a+b=b，2b=b，1=2。`, answers: ['错误'] },
      { question: `证明Σi=n(n+1)/2：n=1时成立，假设n=k成立，n=k+1时Σi=k(k+1)/2+(k+1)=(k+1)(k+2)/2。`, answers: ['正确'] },
      { question: `证明(a+b)/2≥√(ab)：(a+b)/2-√(ab)=(a-√(ab)+b)/2=(√a-√b)²/2≥0。`, answers: ['有缺陷'] },
      { question: `证明不存在最大质数：假设最大质数P，令N=P!+1，N不被≤P质数整除，所以有>P质数，矛盾。`, answers: ['正确'] },
      { question: `证明∞不是数：假设∞是数，∞+1=∞，两边减∞得1=0，矛盾。`, answers: ['有缺陷'] },
      { question: `证明空集唯一：设∅₁和∅₂都是空集，外延公理说集合相等当且仅当元素相同，两者都没元素，所以相等。`, answers: ['正确'] },
      { question: `23人房间两人生日相同的概率=23/365≈6.3%，远低于50%，所以命题为假。`, answers: ['错误'] },
      { question: `证明f(x)=x²在x=0连续：任给ε>0取δ=√ε，|x|<δ⇒|x²|<ε。`, answers: ['正确'] },
    ],
    valQa: [
      { question: `证明：若f'(x)=0对所有x成立，则f(x)是常函数。
证明：由拉格朗日中值定理，对任意a,b，存在c使
f(b)-f(a)=f'(c)(b-a)=0，所以f(b)=f(a)。故f是常函数。`, answers: ['正确'] },
      { question: `证明：0.999...=1
证明：设x=0.999...，则10x=9.999...，两式相减得9x=9，所以x=1。`, answers: ['正确'] },
      { question: `证明：若A∩B=∅，则|P(A∪B)|=|P(A)|+|P(B)|
证明：|P(A∪B)|=2^{|A|+|B|}=2^{|A|}2^{|B|}=|P(A)|+|P(B)|`, answers: ['错误'] },
      { question: `证明：lim_{x→0} sin(x)/x = 1
证明：当x→0时，sin(x)~x，所以sin(x)/x~1，故极限为1。`, answers: ['有缺陷'] },
      { question: `证明：所有正整数n满足 n²+n+41 是质数
验证：n=0得41，n=1得43，n=2得47，n=3得53...都是质数，结论成立。`, answers: ['错误'] },
      { question: `证明：若f(x)在x₀可导，则f(x)在x₀连续。
证明：f'(x₀)=lim_{h→0}[f(x₀+h)-f(x₀)]/h存在，
故lim_{h→0}[f(x₀+h)-f(x₀)]=f'(x₀)·0=0，即连续。`, answers: ['正确'] },
      { question: `证明：√2是无理数
假设√2=p/q为有理数，其中p,q互质。
则2=p²/q²，即p²是偶数，所以p是偶数。
设p=2k，则2q²=4k²，即q²=2k²，所以q也是偶数。
与p,q互质矛盾，故√2是无理数。`, answers: ['正确'] },
      { question: `证明：1+2+3+...+n = n(n+1)/2
当n=1时，左边=1，右边=1，成立。
假设n=k时成立，即1+2+...+k=k(k+1)/2
则n=k+1时，1+2+...+k+(k+1)=k(k+1)/2+(k+1)=(k+1)(k+2)/2
故结论成立。`, answers: ['正确'] },
      { question: `证明：若x是有理数，y是无理数，则x+y是无理数。
反证：假设x+y是有理数，则y=(x+y)-x也是有理数，与y是无理数矛盾。`, answers: ['正确'] },
      { question: `证明：0.1+0.2=0.3
计算：0.1+0.2=0.3，故结论成立。`, answers: ['有缺陷'] },
    ],
  },

  // ════════════════════════════════════════════════════════════════
  // 5. 情感分析专家（初始skill极度简化）
  // ════════════════════════════════════════════════════════════════
  {
    id: 'sentiment-analysis',
    name: '情感分析专家',
    category: 'analysis',
    categoryLabel: '分析类',
    difficulty: 'medium',
    description: '识别文本中的情感倾向，包括正面、负面、中性和反讽',
    icon: '😊',
    env: 'searchqa',
    highlights: [
      '初始skill极度简化：只会输出固定答案"正面"',
      '验证集包含复杂反讽、讽刺、混合情感',
      '初始准确率接近0%，优化空间巨大',
      '展示从"完全不会"到"专业识别"的进化',
    ],
    expectedMetrics: {
      baselineAccuracy: '10%',
      optimizedAccuracy: '90%',
      avgSteps: 7,
      avgPatchesPerStep: 3,
      accuracyGain: '+80%',
    },
    splitRatio: 0.8,
    config: {
      epochs: 7,
      batchSize: 12,
      editBudget: 8,
      lrScheduler: 'cosine',
      gateMetric: 'soft',
      analystWorkers: 8,
    },
    skillContent: `# 情感分析 Skill

## 角色
你是一位情感分析初学者，正在学习识别基本情感。

## 输出格式
只输出情感类型名称，不要解释。`,
    trainQa: [
      { question: `这个产品太棒了！使用体验非常流畅，强烈推荐给大家！`, answers: ['正面'] },
      { question: `这家餐厅真难吃，服务态度也很差，再也不来了！`, answers: ['负面'] },
      { question: `今天天气不错，适合出去走走。`, answers: ['正面'] },
      { question: `这部电影真烂，浪费时间和金钱。`, answers: ['负面'] },
      { question: `呵呵，你可真厉害，把事情搞砸了还装无辜。`, answers: ['负面'] },
      { question: `太棒了！又延期了，我们的项目真准时啊。`, answers: ['负面'] },
      { question: `这个方案很有创意，虽然执行起来有点挑战。`, answers: ['正面'] },
      { question: `表面上看起来不错，但实际上问题很多。`, answers: ['负面'] },
      { question: `这本书开头有点无聊，但越看越精彩。`, answers: ['正面'] },
      { question: `恭喜你啊，又迟到了整整一小时。`, answers: ['负面'] },
      { question: `虽然价格贵了点，但质量确实很好。`, answers: ['正面'] },
      { question: `真不错，又加班到半夜，这班真是上得太值了。`, answers: ['负面'] },
      { question: `这个功能设计得很贴心，解决了我的痛点。`, answers: ['正面'] },
      { question: `好消息！我们的预算又被削减了。`, answers: ['负面'] },
      { question: `会议很高效，问题都解决了。`, answers: ['正面'] },
    ],
    valQa: [
      { question: `真开心啊，周末还要加班。`, answers: ['负面'] },
      { question: `这个电影怎么说呢...中立吧，不好不坏。`, answers: ['中性'] },
      { question: `这家餐厅环境不错，就是菜有点贵，味道也就那样。`, answers: ['中性'] },
      { question: `新产品上线了，虽然还有些bug，但团队真的很努力！`, answers: ['正面'] },
      { question: `恭喜恭喜！又加班到凌晨，身体真是越来越好了呢。`, answers: ['负面'] },
    ],
  },
]

export const DEFAULT_CONFIG = {
  epochs: 4,
  batchSize: 8,
  editBudget: 5,
  lrScheduler: 'cosine',
  gateMetric: 'soft',
  analystWorkers: 8,
}

export const DEFAULT_METRICS = {
  baselineAccuracy: '50%',
  optimizedAccuracy: '80%',
  avgSteps: 4,
  avgPatchesPerStep: 2,
  accuracyGain: '+30%',
}

export const CATEGORIES = [
  { key: 'all', label: '全部', icon: '📚' },
  { key: 'analysis', label: '分析类', icon: '🔍', desc: '代码问题分类、安全漏洞识别' },
  { key: 'computation', label: '计算类', icon: '⚡', desc: 'SQL性能问题识别、算法分析' },
  { key: 'reasoning', label: '推理类', icon: '🧠', desc: '逻辑谬误分类、论证分析' },
  { key: 'comprehensive', label: '综合类', icon: '📐', desc: '数学证明正误判断、多维评估' },
]
