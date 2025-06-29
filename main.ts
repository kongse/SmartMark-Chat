import { Plugin, Editor, Notice, App, PluginSettingTab, Setting } from 'obsidian';

interface AIPluginSettings {
  apiKey: string;
  apiUrl: string;
  modelName: string;
  systemPrompt: string;
  contextLines: number;
  elegantMode: boolean; // 添加elegant mode设置
  enableTimestamp: boolean; // 添加时间戳开关
  httpProxy: string; // HTTP代理设置
  httpsProxy: string; // HTTPS代理设置
  enableProxy: boolean; // 启用代理开关
  includeThoughts: boolean; // 是否显示思考过程
  thinkingBudget: number; // 思考token限制
  autoAddSeparator: boolean; // 自动添加= =分隔符
  separatorCount: number; // 分隔符数量设置
}

const DEFAULT_SETTINGS: AIPluginSettings = {
  apiKey: "",
  apiUrl: "https://api.openai.com/v1/chat/completions",
  modelName: "gpt-3.5-turbo",
  systemPrompt: "你是一个有帮助的AI助手",
  contextLines: 3,
  elegantMode: true, // 默认关闭elegant mode
  enableTimestamp: true, // 默认开启时间戳
  httpProxy: "", // 默认无HTTP代理
  httpsProxy: "", // 默认无HTTPS代理
  enableProxy: false, // 默认关闭代理
  includeThoughts: false, // 默认不显示思考过程
  thinkingBudget: 0, // 默认思考token限制为0
  autoAddSeparator: true, // 默认开启自动添加= =分隔符
  separatorCount: 12 // 默认分隔符数量为12
};

// 主插件类
export default class AIPlugin extends Plugin {
  settings: AIPluginSettings = DEFAULT_SETTINGS;
  private streamInsertPosition: { line: number, ch: number } | null = null;
  private lastContentLength = 0;
  private statusNotice: Notice | null = null; // 添加状态提示变量
  private currentAbortController: AbortController | null = null; // 添加中断控制器
  private isStreaming = false; // 添加流式状态标记

  async onload() {
    await this.loadSettings();
    //  按快捷键时执行
    this.addCommand({
      id: 'ask-ai',
      name: 'Ask AI',
      hotkeys: [{ modifiers: ["Ctrl"], key: "Enter" }],
      editorCallback: async (editor: Editor) => {
        try {
          const cursor = editor.getCursor();
          let currentLineNum = cursor.line;
          const currentLine = editor.getLine(currentLineNum);
      
          if (!this.settings.apiKey) {
            new Notice("⚠️ Please SETUP API Keys First！");
            return;
          }
      
          // 按照新规范处理用户问题
          await this.processUserQuestionAndCallAI(editor, currentLineNum);
      
        } catch (error) {
          new Notice(`CALL AI API ERROR: ${error}`);
          console.error(error);
        }
      }
    });

    // 添加命令用于格式化文本
    this.addCommand({
      id: 'format-text',
      name: 'Format selected text',
      editorCallback: (editor: Editor) => {
        this.formatSelectedText(editor);
      }
    });

    // 添加中断AI回复的快捷键  (CTRL U)
    this.addCommand({
      id: 'interrupt-ai',
      name: 'Interrupt AI Response',
      hotkeys: [{ modifiers: ["Ctrl"], key: "u" }],
      callback: () => {
        this.interruptAI();
      }
    });

    // 添加设置选项卡 (用于配置AI参数等)
    this.addSettingTab(new AISettingsTab(this.app, this));
  }

  // OpenAI API调用函数
  private async callOpenAI(input: string): Promise<string> {
    // 显示开始状态
    this.showStatusNotice("🤖 AI正在思考中...");
    
    try {
      const response = await this.generateResponse(input);
      return response;
    } catch (error) {
      // 出错时隐藏状态提示
      this.hideStatusNotice();
      this.isStreaming = false;
      throw error;
    }
  }

  // 按照新SmartMark规范处理用户问题并调用AI
  private async processUserQuestionAndCallAI(editor: Editor, currentLineNum: number): Promise<void> {
    const currentLine = editor.getLine(currentLineNum);
    
    // 重置流式输出位置
    this.streamInsertPosition = null;
    this.lastContentLength = 0;
    
    // 用户问题范围判定
    let userQuestionLines: string[] = [];
    
    if (currentLine.trim() !== '') {
      // 如果当前行不是空行，只将当前行作为用户输入
      userQuestionLines = [currentLine];
    } else {
      // 如果当前行是空行，向上搜索直到遇到分隔符或到达文件开头
      for (let i = currentLineNum - 1; i >= 0; i--) {
        const line = editor.getLine(i);
        const trimmedLine = line.trim();
        
        // 检查是否遇到终止条件
        if (trimmedLine.match(/^-{4,}$/) || trimmedLine.match(/^={4,}$/) || trimmedLine.match(/^x{4,}$/i)) {
          break;
        }
        
        userQuestionLines.unshift(line);
      }
    }
    
    // 在用户问题下面插入分隔符
    const separatorLine = '-'.repeat(this.settings.separatorCount);
    const insertPosition = { line: currentLineNum + 1, ch: 0 };
    
    // 插入格式：用户问题下一行是------，然后空一行
    editor.replaceRange(`\n${separatorLine}\n`, insertPosition);
    
    // 设置AI回答的插入位置（在------下面空一行）
    this.streamInsertPosition = { line: currentLineNum + 3, ch: 0 };
    
    // 将光标移动到AI回答应该开始的位置
    editor.setCursor(this.streamInsertPosition);
    
    // 调用AI
    await this.callOpenAI("");
  }

  // 中断AI回复
  private interruptAI(): void {
    if (this.isStreaming && this.currentAbortController) {
      this.currentAbortController.abort();
      this.hideStatusNotice();
      this.showStatusNotice("⚠️ AI回复已中断");
      
      // 在编辑器中添加中断标记
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor && this.streamInsertPosition) {
        const endPos = {
          line: this.streamInsertPosition.line,
          ch: this.streamInsertPosition.ch + this.lastContentLength
        };
        const separatorLine = '='.repeat(this.settings.separatorCount);
        editor.replaceRange(`\n[AI回复已中断]\n\n${separatorLine}\n\n`, endPos);
      }
      
      this.isStreaming = false;
      this.currentAbortController = null;
      
      // 2秒后隐藏中断提示
      setTimeout(() => {
        this.hideStatusNotice();
      }, 2000);
    } else {
      new Notice("当前没有正在进行的AI回复");
    }
  }

  private async generateResponse(prompt: string): Promise<string> {
    // 重置流式输出状态
    this.streamInsertPosition = null;
    this.lastContentLength = 0;
    this.isStreaming = true;
    
    // 创建新的AbortController
    this.currentAbortController = new AbortController();
    
    // 获取上下文对话
    const messages = await this.getContextMessages();
    
    // 构建完整的消息数组
    const fullMessages = [
        { role: "system", content: this.settings.systemPrompt },
        ...messages,
       // { role: "user", content: prompt }  //以前单行输入按CTRL+ENTER是，当前行会采集为prompt，这里输入，现在因为是全文采集，不需要了。
    ];
    
    // 将消息转换为JSON字符串并复制到剪贴板
    await navigator.clipboard.writeText(JSON.stringify(fullMessages, null, 2));
    new Notice("已将对话上下文复制到剪贴板");
    
    // 更新状态为连接中
    this.updateStatusNotice("🔗 正在连接AI服务...");
    
    // 构建fetch选项
    const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
            model: this.settings.modelName,
            messages: fullMessages,
            stream: true,  // 启用流式传输
            extra_body: {
              "google": {
                "thinking_config": {
                  "include_thoughts": this.settings.includeThoughts,    //是否显示思考过程
                  "thinkingBudget": this.settings.thinkingBudget       //思考token限制，改为0则不思考，注意openai api不支持很多特性 https://ai.google.dev/gemini-api/docs/openai?hl=zh-cn
                }
              }
            }
        }),
        signal: this.currentAbortController.signal  // 添加中断信号
    };
    
    // 如果启用了代理，设置代理环境变量
    if (this.settings.enableProxy) {
        // 在Node.js环境中设置代理环境变量
        if (typeof process !== 'undefined' && process.env) {
            if (this.settings.httpProxy) {
                process.env.HTTP_PROXY = this.settings.httpProxy;
                process.env.http_proxy = this.settings.httpProxy;
            }
            if (this.settings.httpsProxy) {
                process.env.HTTPS_PROXY = this.settings.httpsProxy;
                process.env.https_proxy = this.settings.httpsProxy;
            }
        }
    } else {
        // 禁用代理时清空环境变量
        if (typeof process !== 'undefined' && process.env) {
            process.env.HTTP_PROXY = '';
            process.env.HTTPS_PROXY = '';
            process.env.http_proxy = '';
            process.env.https_proxy = '';
        }
    }
    
    const response = await fetch(this.settings.apiUrl, fetchOptions);

    if (!response.body) {
        this.hideStatusNotice();
        throw new Error('Response body is null');
    }

    // 更新状态为接收回复
    this.updateStatusNotice("📝 AI正在回复中...");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';

    try {
        while (true) {
            // 检查是否被中断
            if (this.currentAbortController?.signal.aborted) {
                break;
            }
            
            const { done, value } = await reader.read();
            if (done) {
                // 流式输出结束，添加<<标记
                this.finalizeStreamingContent();
                // 隐藏状态提示
                this.hideStatusNotice();
                this.isStreaming = false;
                break;
            }

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        this.finalizeStreamingContent();
                        this.hideStatusNotice();
                        this.isStreaming = false;
                        return result;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            result += content;
                            // 增量更新编辑器内容
                            this.updateStreamingContent(content);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    } catch (error) {
        // 处理中断错误
        if (error.name === 'AbortError') {
            // 请求被中断，这是正常情况
            this.isStreaming = false;
            return result;
        }
        throw error;
    } finally {
        reader.releaseLock();
        // 确保状态提示被隐藏
        this.hideStatusNotice();
        this.isStreaming = false;
        this.currentAbortController = null;
    }

    return result;
  }

  // 显示状态提示
  private showStatusNotice(message: string) {
    // 如果已有状态提示，先隐藏
    this.hideStatusNotice();
    
    // 创建新的状态提示，设置较长的显示时间
    this.statusNotice = new Notice(message, 0); // 0表示不自动隐藏
  }

  // 更新状态提示内容
  private updateStatusNotice(message: string) {
    if (this.statusNotice) {
      // 隐藏当前提示，显示新提示
      this.hideStatusNotice();
    }
    this.showStatusNotice(message);
  }

  // 隐藏状态提示
  private hideStatusNotice() {
    if (this.statusNotice) {
      this.statusNotice.hide();
      this.statusNotice = null;
    }
  }

  // 保存收集的内容到消息数组的辅助函数
  private saveCollectedContent(
    messages: Array<{role: string, content: string}>,
    collectingContent: string,
    collectingMode: 'user' | 'assistant' | 'none'
  ): void {
    if (collectingContent.trim() && collectingMode !== 'none') {
      messages.unshift({
        role: collectingMode,
        content: collectingContent.trim()
      });
    }
  }

  private async getContextMessages(): Promise<Array<{role: string, content: string}>> {
      const editor = this.app.workspace.activeEditor?.editor;
      if (!editor) return [];
      
      const currentLine = editor.getCursor().line;
      const messages: Array<{role: string, content: string}> = [];
      let collectingContent = "";
      let collectingMode: 'user' | 'assistant' | 'none' = 'none';
      
      // 从当前行向上遍历
      for (let i = currentLine; i >= 0 && messages.length < this.settings.contextLines * 2; i--) {
          const line = editor.getLine(i);
          const trimmedLine = line.trim();
          
          // 检查终止条件：遇到xxxxx（大于3个x）
          if (trimmedLine.match(/^x{4,}$/i)) {
              // 终止收集循环
              break;
          }
          
          // 检查AI回答结束标记（=====）
          if (trimmedLine.match(/^={4,}$/)) {
              // 保存之前收集的内容（如果有）
              this.saveCollectedContent(messages, collectingContent, collectingMode);
              
              // 开始收集AI回答（=====上面的内容是AI回答）
              collectingContent = "";
              collectingMode = 'assistant';
          }
          // 检查用户问题结束标记（-----）
          else if (trimmedLine.match(/^-{4,}$/)) {
              // 保存之前收集的内容（如果有）
              this.saveCollectedContent(messages, collectingContent, collectingMode);
              
              // 开始收集用户问题（-----上面的内容是用户问题）
          collectingContent = "";
          collectingMode = 'user';
          }
          else if (collectingMode !== 'none') {
              // 在收集模式下，收集当前行内容
              if (collectingContent) {
                  collectingContent = line + '\n' + collectingContent;
              } else {
                  collectingContent = line;
              }
          }
      }
      
      // 处理遍历结束时可能未保存的内容
      this.saveCollectedContent(messages, collectingContent, collectingMode);
      
      return messages;
  }

// Flowing Content Updater
private updateStreamingContent(newContent: string) {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return;
    
    // 如果还没有设置插入位置，说明不是通过新规范调用的，使用旧的逻辑
    if (!this.streamInsertPosition) {
        const cursor = editor.getCursor();
        // 确保插入位置不会超出文档边界
        const doc = editor.getDoc();
        const lastLine = doc.lastLine();
        const lastLineLength = doc.getLine(lastLine).length;
        
        // 如果光标在最后一行，先添加换行符
        if (cursor.line >= lastLine) {
            const endPos = { line: lastLine, ch: lastLineLength };
            editor.replaceRange("\n", endPos);
            this.streamInsertPosition = { line: lastLine + 1, ch: 0 };
        } else {
            this.streamInsertPosition = { line: cursor.line + 1, ch: 0 };
        }
    }
    
    // 计算当前应该插入的位置
    const currentPos = {
        line: this.streamInsertPosition.line,
        ch: this.streamInsertPosition.ch + this.lastContentLength
    };
    
    // 处理思考标签：将<thought>替换为[thought]，</thought>替换为[/thought]
    const processedContent = newContent
        .replace(/<thought>/g, '[thought]')
        .replace(/<\/thought>/g, '[/thought]');
    
    // 只插入新增的内容
    editor.replaceRange(processedContent, currentPos);
    this.lastContentLength += processedContent.length;
}

// 在流式输出结束后添加=====标记
private finalizeStreamingContent() {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor || !this.streamInsertPosition) return;
    
    // 获取当前AI回答内容的结束位置
    const endPos = {
        line: this.streamInsertPosition.line,
        ch: this.streamInsertPosition.ch + this.lastContentLength
    };

    // 按照新规范：AI回答下面的=====上下均空一行
    const separatorLine = '='.repeat(this.settings.separatorCount);
    let finalContent = `\n\n${separatorLine}\n\n`;
    
    // 如果启用了时间戳，添加emacs格式的时间戳
    if (this.settings.enableTimestamp) {
        const now = new Date();
        // 生成emacs格式的时间戳：<2024-01-15 Mon 14:30:25 +0800>
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const weekday = weekdays[now.getDay()];
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        
        // 获取时区偏移
        const timezoneOffset = -now.getTimezoneOffset();
        const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
        const offsetMinutes = Math.abs(timezoneOffset) % 60;
        const offsetSign = timezoneOffset >= 0 ? '+' : '-';
        const timezone = `${offsetSign}${String(offsetHours).padStart(2, '0')}${String(offsetMinutes).padStart(2, '0')}`;
        
        const emacsTimestamp = `<!-- ${year}-${month}-${day} ${weekday} ${hour}:${minute}:${second} ${timezone} -->`;
        finalContent = finalContent.slice(0, -2) + `${emacsTimestamp}\n\n`; // 在最后的空行前插入时间戳
    }

    editor.replaceRange(finalContent, endPos);
}

// 加载设置
private async loadSettings() {
    this.settings = Object.assign({}, this.settings, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }



  // 格式化用户输入行
  // 格式化用户输入行
private async formatSelectedText(editor: Editor): Promise<{ line: number, ch: number }> {
    const cursor = editor.getCursor();
    const baseLine = cursor.line; // 统一使用执行时光标所在行作为基础行号
    const originalText = editor.getLine(baseLine);

    // 1. 检查行首是否已经===，如果没有才插入
    if (!originalText.startsWith('===')) {
        editor.replaceRange("===", { line: baseLine, ch: 0 });
    }
    
    // 2. 在下一行添加USER:前缀
    //editor.setLine(baseLine, `USER: ${originalText}`);
    
    // 3. 在再下一行插入代码块结束标记
    // editor.replaceRange("\n```", { line: baseLine, ch: 0 });
    
    // 4. 返回结束位置（代码块结束标记的下一行开头）
    return { 
        line: baseLine + 3, // 基础行 + 3行
        ch: 0
    };
}

// 发送文本到AI
async sendToAI() {
  const editor = this.app.workspace.activeEditor?.editor;
  if (!editor) return;

  // 获取当前光标位置作为基础行号
  const baseLine = editor.getCursor().line;
  const query = editor.getSelection() || editor.getLine(baseLine); // 优先使用选中文本，没有则用整行

  // 格式化文本并获取插入位置
  const insertPos = await this.formatSelectedText(editor);
  
  try {
      // 获取AI回复 - 流式输出已经在generateResponse中处理了
      await this.callOpenAI(query);
      
      // 移动光标到AI回复的末尾
      editor.setCursor(editor.lastLine());
      
  } catch (error) {
      console.error("AI调用失败:", error);
      editor.replaceRange("\n[AI请求失败]\n", insertPos);
  }
}
}

// 设置 AI 选项卡
class AISettingsTab extends PluginSettingTab {
    // 显式声明私有属性
    private plugin: AIPlugin;

    constructor(app: App, plugin: AIPlugin) {
        super(app, plugin);
        this.plugin = plugin; // 必须赋值
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("API密钥")
            .setDesc("输入OpenAI或兼容API的密钥")
            .addText(text => text
                .setPlaceholder("sk-xxxxxxxx")
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));
    
        new Setting(containerEl)
            .setName("API地址")
            .setDesc("默认OpenAI官方API，可替换为本地Ollama/LM Studio")
            .addText(text => text
                .setPlaceholder("https://api.openai.com/v1/chat/completions")
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value;
                    await this.plugin.saveSettings();
                }));
    
        new Setting(containerEl)
            .setName("模型名称")
            .setDesc("设置要使用的AI模型名称（如gpt-3.5-turbo, gpt-4等）")
            .addText(text => text
                .setPlaceholder("gpt-3.5-turbo")
                .setValue(this.plugin.settings.modelName)
                .onChange(async (value) => {
                    this.plugin.settings.modelName = value;
                    await this.plugin.saveSettings();
                }));
    
        new Setting(containerEl)
            .setName("系统提示词")
            .setDesc("设置AI的系统角色和初始指令")
            .addTextArea(text => {
                text.setPlaceholder("你是一个有帮助的AI助手")
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.plugin.saveSettings();
                    });
                
                // 设置文本区域的大小
                text.inputEl.rows = 8;  // 设置行数为8行
                text.inputEl.cols = 50; // 设置列数为50列
                text.inputEl.style.width = '100%';  // 设置宽度为100%
                text.inputEl.style.minHeight = '120px';  // 设置最小高度
                text.inputEl.style.resize = 'vertical';  // 允许垂直调整大小
            });
    
        new Setting(containerEl)
            .setName("上下文对话轮数")
            .setDesc("设置在调用AI时收集多少轮历史对话作为上下文（0表示不收集）")
            .addText(text => text
                .setPlaceholder("3")
                .setValue(String(this.plugin.settings.contextLines))
                .onChange(async (value) => {
                    this.plugin.settings.contextLines = Number(value) || 0;
                    await this.plugin.saveSettings();
                }));
    
    // 添加elegant mode设置
    new Setting(containerEl)
        .setName("Elegant Mode")
        .setDesc("开启后，AI回复的分隔符前会添加额外的换行符，让格式更加优雅")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.elegantMode)
            .onChange(async (value) => {
                this.plugin.settings.elegantMode = value;
                await this.plugin.saveSettings();
            }));

    // 添加时间戳设置
    new Setting(containerEl)
        .setName("启用时间戳")
        .setDesc("开启后，在AI回复结束的= =标记下方添加emacs格式的时间戳")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.enableTimestamp)
            .onChange(async (value) => {
                this.plugin.settings.enableTimestamp = value;
                await this.plugin.saveSettings();
            }));

    // 添加思考功能设置分隔符
    containerEl.createEl('h3', { text: '思考功能设置（仅支持Gemini模型）' });

    // 添加显示思考过程设置
    new Setting(containerEl)
        .setName("显示思考过程")
        .setDesc("开启后，AI会在回复中包含思考过程（仅Gemini模型支持）")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.includeThoughts)
            .onChange(async (value) => {
                this.plugin.settings.includeThoughts = value;
                await this.plugin.saveSettings();
            }));

    // 添加思考token限制设置
    new Setting(containerEl)
        .setName("思考Token限制")
        .setDesc("设置AI思考过程的token数量限制，0表示不进行思考（仅Gemini模型支持）")
        .addText(text => text
            .setPlaceholder("0")
            .setValue(String(this.plugin.settings.thinkingBudget))
            .onChange(async (value) => {
                this.plugin.settings.thinkingBudget = Number(value) || 0;
                await this.plugin.saveSettings();
            }));

    // 添加聊天功能设置分隔符
    containerEl.createEl('h3', { text: '聊天功能设置' });

    // 添加分隔符数量设置
    new Setting(containerEl)
        .setName("分隔符数量")
        .setDesc("设置-----和=====的数量（必须大于3，默认值是12）")
        .addText(text => text
            .setPlaceholder("12")
            .setValue(String(this.plugin.settings.separatorCount))
            .onChange(async (value) => {
                const count = Number(value) || 12;
                if (count > 3) {
                    this.plugin.settings.separatorCount = count;
                    await this.plugin.saveSettings();
                } else {
                    new Notice("分隔符数量必须大于3");
                    text.setValue(String(this.plugin.settings.separatorCount));
                }
            }));

    // 添加自动添加= =分隔符设置
    new Setting(containerEl)
        .setName("Auto add = = when chat")
        .setDesc("开启后，执行插件时会自动检查当前位置上方5行是否有= =符号，如果没有则自动插入，并在AI回答结束后添加-----分隔符")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.autoAddSeparator)
            .onChange(async (value) => {
                this.plugin.settings.autoAddSeparator = value;
                await this.plugin.saveSettings();
            }));

    // 添加代理设置分隔符
    containerEl.createEl('h3', { text: '代理设置' });

    // 添加代理开关
    new Setting(containerEl)
        .setName("启用代理")
        .setDesc("开启后，API请求将通过指定的代理服务器进行")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.enableProxy)
            .onChange(async (value) => {
                this.plugin.settings.enableProxy = value;
                await this.plugin.saveSettings();
            }));

    // 添加HTTP代理设置
    new Setting(containerEl)
        .setName("HTTP代理")
        .setDesc("设置HTTP代理地址，格式：http://proxy.example.com:8080")
        .addText(text => text
            .setPlaceholder("http://proxy.example.com:8080")
            .setValue(this.plugin.settings.httpProxy)
            .onChange(async (value) => {
                this.plugin.settings.httpProxy = value;
                await this.plugin.saveSettings();
            }));

    // 添加HTTPS代理设置
    new Setting(containerEl)
        .setName("HTTPS代理")
        .setDesc("设置HTTPS代理地址，格式：http://proxy.example.com:8080")
        .addText(text => text
            .setPlaceholder("http://proxy.example.com:8080")
            .setValue(this.plugin.settings.httpsProxy)
            .onChange(async (value) => {
                this.plugin.settings.httpsProxy = value;
                await this.plugin.saveSettings();
            }));
}
}