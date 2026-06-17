# AnnaVisual Brand MVP 需求文档

## 1.1 目标

本 MVP 目标是验证 AnnaVisual 的核心能力：

用户上传品牌资料后，Anna 可以自动理解品牌视觉规范，并在后续图片生成中按照该品牌规范完成设计。

MVP 不追求完整品牌管理系统，优先验证以下闭环：

```text
上传图片 / PDF
  ↓
生成 Brand Profile
  ↓
用户确认或简单修改
  ↓
输入作图需求
  ↓
生成符合 Brand 的图片
```

参考传统 VI 手册中常见的 logo、颜色、字体、禁用规则、应用示例等内容，例如上传文件中包含 logo 使用规范、错误用法、标准色、字体、吉祥物和物料应用示例。

---

## 2. 核心用户流程

### 2.1 创建 Brand

用户进入 Brand 页面，点击：

```text
Create Brand
```

进入创建流程。

用户需要上传至少一种品牌资料：

- 品牌手册 PDF
- 品牌图片
- Logo 图片
- 过往海报 / 社媒图 / PPT 封面
- 官网截图
- 产品截图

MVP 阶段支持：

- PDF 上传
- 图片上传

上传完成后，用户点击：

```text
Generate Brand
```

Anna 开始解析资料。

---

### 2.2 Anna 解析品牌资料

Anna 需要从上传资料中提取以下信息。

#### A. Brand Basic Profile

包括：

- Brand name
- Brand description
- 品牌关键词
- 品牌气质
- 适合场景
- 不适合场景

示例字段：

```json
{
  "brand_name": "TalentSec",
  "brand_description": "A cybersecurity brand with clean, technical, and trustworthy visual identity.",
  "brand_keywords": ["secure", "clean", "technical", "professional"],
  "avoid_keywords": ["cartoonish", "neon", "chaotic", "unreadable"]
}
```

---

#### B. Color Rules

Anna 需要识别并总结品牌颜色。

MVP 至少需要提取：

- 主色
- 辅助色
- 背景色
- 禁用色或慎用色
- 色彩使用说明

示例字段：

```json
{
  "primary_colors": [
    { "name": "Brand Blue", "hex": "#59C0D6" },
    { "name": "White", "hex": "#FFFFFF" }
  ],
  "secondary_colors": [
    { "name": "Light Blue", "hex": "#c2eff9" },
    { "name": "Grey", "hex": "#f1f1f1" }
  ],
  "color_rules": [
    "Use blue and white as the core brand color pairing.",
    "Use high-contrast logo version on dark backgrounds."
  ]
}
```

---

#### C. Logo Rules

Anna 需要提取 logo 使用规则。

MVP 至少需要支持：

- logo 是否可以改色
- logo 是否可以拉伸
- logo 是否可以旋转
- logo 是否可以拆分
- logo 推荐版本
- logo 在深浅背景上的使用要求

参考文件中明确提到，品牌标志不得修改、缩放变形、重新绘制；并且错误用法包括删除元素、拉伸变形、随意改色、旋转、描边、改动比例等。

当前重点硬约束：

- Logo 必须被视为固定品牌资产，而不是让生图模型重新绘制的装饰元素。
- 默认流程应使用 logo overlay / fixed asset placement，而不是在图片生成 prompt 中要求模型生成 logo。
- 如果用户上传了 logo 原稿，最终 prompt 必须明确说明：不要重新绘制 logo、不要改色、不要旋转、不要拉伸、不要拆分、不要描边、不要改变比例。
- 如果需要展示 logo，应保留清晰摆放位置和安全间距，但不要求大面积空白或生硬留白。

示例字段：

```json
{
  "logo_rules": [
    "Do not stretch or distort the logo.",
    "Do not rotate the logo.",
    "Do not change logo colors unless an approved monochrome version is used.",
    "Do not remove parts of the logo.",
    "Use the horizontal logo version by default."
  ]
}
```

---

#### D. Typography Rules

Anna 需要识别字体规范。

MVP 至少需要提取：

- 中文标题字体
- 中文正文字体
- 英文标题字体
- 英文正文字体
- 字体风格说明

参考文件中中文字体使用思源黑体不同字重，英文字体使用 Poppins 不同字重。

示例字段：

```json
{
  "typography": {
    "chinese": {
      "title": "Source Han Sans Heavy / Bold",
      "body": "Source Han Sans Regular"
    },
    "english": {
      "title": "Poppins Black",
      "subtitle": "Poppins SemiBold",
      "body": "Poppins ExtraLight"
    }
  }
}
```

---

#### E. Visual Style Rules

Anna 需要总结品牌视觉风格。

MVP 至少需要包括：

- 画面气质
- 构图倾向
- 信息密度
- 背景风格
- 图形 / 插画 / 吉祥物使用方式
- 禁止事项

示例字段：

```json
{
  "visual_style": {
    "tone": "clean, friendly, technical, trustworthy",
    "composition": "minimal layout with generous white space",
    "density": "low to medium",
    "background": "white, light blue, or soft grey backgrounds",
    "do": [
      "Use clean layouts",
      "Keep enough white space",
      "Use brand blue as the main accent"
    ],
    "do_not": [
      "Do not use messy backgrounds",
      "Do not use unrelated bright colors",
      "Do not create distorted mascot or logo"
    ]
  }
}
```

---

## 3. Brand Guideline 生成

Anna 解析完成后，需要生成一个用户可查看的 Brand 页面。

MVP 页面不需要复杂排版，先展示以下模块即可：

- Brand Summary
- Color System
- Logo Rules
- Typography
- Visual Style
- Do / Don’t
- Source Files

每个模块都需要允许用户修改文本。

MVP 页面结构：

```text
Brand name
Brand description

[Colors]
- Primary colors
- Secondary colors
- Color usage notes

[Logo]
- Recommended logo usage
- Forbidden logo usage

[Typography]
- Chinese fonts
- English fonts

[Visual Style]
- Tone
- Composition
- Background
- Density

[Do / Don’t]
- Do
- Don’t

[Source files]
- Uploaded PDF / images
```

用户可以点击：

```text
Save Brand
```

保存该 Brand。

---

## 4. Brand 编辑与确认

MVP 阶段只需要支持轻量编辑。

### 4.1 用户可编辑内容

用户可以修改：

- Brand name
- Brand description
- Brand keywords
- Color rules
- Logo rules
- Typography notes
- Visual style
- Do / Don’t

不需要做复杂的版本管理。

### 4.2 用户确认

Brand 生成后，状态默认为：

```text
Draft
```

用户点击：

```text
Confirm Brand
```

后状态变为：

```text
Active
```

只有 Active Brand 可以用于后续生成图片。

---

## 5. Brand 在生成图片中的调用

用户进入作图页面，输入需求。

例如：

```text
帮我做一张 LinkedIn 海报，主题是“企业为什么需要安全的 AI Agent”，风格专业、清晰、有科技感。
```

用户选择一个 Brand：

```text
Brand: TalentSec
```

点击：

```text
Create Visual
```

Anna 在生成图片时必须调用该 Brand 的规则。

---

### 5.1 生成时必须遵守的 Brand Rules

生成图片时，Anna 至少需要使用以下内容作为约束：

- Brand description
- Color rules
- Logo rules
- Typography rules
- Visual style
- Do / Don’t

生成逻辑：

```text
用户作图需求
+
Brand Profile
+
Brand Rules
=
生成图片 prompt / image generation instruction
```

Logo 相关生成规则必须作为硬约束注入 prompt：

- 不允许生图模型幻想、重绘、变形或伪造 logo。
- 如果 logo 已作为素材存在，应把它作为固定 overlay 资产处理。
- Prompt 应描述 logo 的摆放原则，而不是要求模型“画出一个 logo”。
- 对 logo 的颜色、比例、旋转、拆分、描边和元素完整性进行明确禁止。
- 如果最终图需要保留 logo 区域，应使用自然构图或合理层级，而不是强制生成奇怪的大面积留白。

---

### 5.2 MVP 输出要求

生成结果至少需要满足：

- 使用品牌主色或辅助色
- 整体风格符合 Brand visual style
- 不使用 Brand 明确禁止的风格
- 不随意修改 logo
- 不使用明显冲突的字体风格
- 如果有吉祥物 / IP，不要改变其核心特征
- 生成后给出一段简短说明：为什么这张图符合品牌规范

示例输出说明：

```text
This visual follows the TalentSec brand by using the approved blue-white palette, clean layout, low information density, and professional cybersecurity tone. The logo is kept undistorted and placed with sufficient clear space.
```

---

## 7. MVP 不做的内容

第一版先不做：

- 多 Designer 管理
- Designer 和 Brand 的复杂绑定关系
- 多版本 Brand Guideline
- 企业级审批流
- 复杂品牌资产库
- Logo 自动抠图 / 矢量化
- 品牌一致性自动评分
- 多人协作
- 权限管理
- 完整 VI 手册导出 PDF
- 多语言品牌手册

这些可以后续做。

---

## 8. 验收标准

MVP 完成后，需要能跑通以下流程。

### Case 1：从品牌资料生成 Brand

用户上传一份品牌 PDF 或多张品牌图片后，系统可以生成：

- Brand name
- Brand description
- Color rules
- Logo rules
- Typography
- Visual style
- Do / Don’t

用户可以编辑并保存。

---

### Case 2：用 Brand 约束生成图片

用户选择已确认的 Brand，输入作图需求，系统生成图片。

生成结果需要：

- 使用品牌颜色
- 符合品牌视觉风格
- 避免品牌禁用事项
- 不明显破坏 logo / mascot / core asset
- 给出品牌符合性说明

---

### Case 3：生成结果可沉淀回 Brand

用户可以把满意的生成结果保存为：

```text
Brand Reference
```

保存后，该图片出现在 Brand Detail 的 References 区域。

---

## 9. 最小数据结构建议

```json
{
  "brand_id": "brand_001",
  "brand_name": "TalentSec",
  "status": "draft",
  "source_files": [
    {
      "file_id": "file_001",
      "file_name": "brand_guideline.pdf",
      "file_type": "pdf"
    }
  ],
  "brand_profile": {
    "description": "",
    "keywords": [],
    "avoid_keywords": []
  },
  "colors": {
    "primary": [],
    "secondary": [],
    "rules": []
  },
  "logo_rules": [],
  "typography": {},
  "visual_style": {
    "tone": "",
    "composition": "",
    "density": "",
    "background": "",
    "do": [],
    "do_not": []
  },
  "references": []
}
```

---

## 10. 一句话 PRD 总结

Brand MVP 要先实现一个最小闭环：用户上传品牌资料，Anna 自动生成可编辑的品牌规范，并在后续作图时把该规范作为硬约束，生成符合企业品牌要求的图片。
