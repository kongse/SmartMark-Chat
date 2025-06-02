import { Plugin, Editor, Notice, App, PluginSettingTab, Setting } from 'obsidian';

interface AIPluginSettings {
  apiKey: string;
  apiUrl: string;
  modelName: string;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: AIPluginSettings = {
  apiKey: "",
  apiUrl: "https://api.openai.com/v1/chat/completions",
  modelName: "gpt-3.5-turbo",  // 确保有默认值
  systemPrompt: "你是一个有帮助的AI助手"
};

export default class AIPlugin extends Plugin {
  settings: AIPluginSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'call-ai-api',
      name: 'Call AI API',
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "A" }],
      editorCallback: async (editor: Editor) => {
        try {
          const cursor = editor.getCursor();
          const currentLine = editor.getLine(cursor.line);

          if (!this.settings.apiKey) {
            new Notice("⚠️ 请先在插件设置中填写API密钥！");
            return;
          }

          // 先格式化文本
          this.formatSelectedText(editor);

          // 获取格式化后的当前行内容（去掉"USER: "前缀）
          const formattedLine = editor.getLine(cursor.line);
          const queryText = formattedLine.replace("USER: ", "");

          const aiResponse = await this.callOpenAI(queryText);

          // 在下一行插入回复
          editor.replaceRange(
            //`\nAI: ${aiResponse}\n`,
            `\n${aiResponse}\n`,
            { line: cursor.line + 2, ch: 0 }
          );
        } catch (error) {
          new Notice(`调用AI API出错: ${error}`);
          console.error(error);
        }
      }
    });

    this.addCommand({
      id: 'format-text',
      name: 'Format selected text',
      editorCallback: (editor: Editor) => {
        this.formatSelectedText(editor);
      }
    });

    // 添加设置选项卡（用于配置API密钥）
    this.addSettingTab(new AISettingsTab(this.app, this));
  }

  private async callOpenAI(input: string): Promise<string> {
    const response = await this.generateResponse(input);
    return response;
  }

  private async generateResponse(prompt: string): Promise<string> {
    const response = await fetch(this.settings.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.settings.apiKey}`
      },
      body: JSON.stringify({
        model: this.settings.modelName,
        messages: [
          { role: "system", content: this.settings.systemPrompt },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await response.json();
    return data.choices[0].message.content;
  }

  private async loadSettings() {
    this.settings = Object.assign({}, this.settings, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async formatSelectedText(editor: Editor): Promise<{ line: number, ch: number }> {
    const cursor = editor.getCursor();
    const baseLine = cursor.line; // 统一使用执行时光标所在行作为基础行号
    const originalText = editor.getLine(baseLine);

    // 1. 在基础行插入代码块开始标记
    editor.replaceRange(">USER: ", { line: baseLine, ch: 0 });
    
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

async sendToAI() {
  const editor = this.app.workspace.activeEditor?.editor;
  if (!editor) return;

  // 获取当前光标位置作为基础行号
  const baseLine = editor.getCursor().line;
  const query = editor.getSelection() || editor.getLine(baseLine); // 优先使用选中文本，没有则用整行

  // 格式化文本并获取插入位置
  const insertPos = await this.formatSelectedText(editor);
  
  try {
      // 获取AI回复
      const aiResponse = await this.callOpenAI(query);
      
      // 在计算好的位置插入AI回复
      editor.replaceRange(`${aiResponse}\n`, insertPos);
      
      // 移动光标到AI回复的末尾
      editor.setCursor(editor.lastLine());
      
  } catch (error) {
      console.error("AI调用失败:", error);
      editor.replaceRange("\n[AI请求失败]\n", insertPos);
  }
}
}

class AISettingsTab extends PluginSettingTab {
  /**
   * Creates a new instance of the class.
   * @param app - The Obsidian App instance
   * @param plugin - Reference to the parent AI plugin instance
   */
  constructor(app: App, private plugin: AIPlugin) {
    super(app, plugin);
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
      .addTextArea(text => text
        .setPlaceholder("你是一个有帮助的AI助手")
        .setValue(this.plugin.settings.systemPrompt)
        .onChange(async (value) => {
          this.plugin.settings.systemPrompt = value;
          await this.plugin.saveSettings();
        }));
  }
}