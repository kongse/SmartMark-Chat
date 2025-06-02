import { Plugin, Editor, Notice, App, PluginSettingTab, Setting } from 'obsidian';
import axios from 'axios';

interface AIPluginSettings {
  apiKey: string;
  apiUrl: string;
  systemPrompt: string;
}

export default class AIPlugin extends Plugin {
  private settings: AIPluginSettings = {
    apiKey: "",
    apiUrl: "https://api.siliconflow.cn/v1/chat/completions",
    systemPrompt: "你是一个有帮助的AI助手"
  };

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

          const aiResponse = await this.callOpenAI(currentLine);

          // 在下一行插入回复
          editor.replaceRange(
            `\n${aiResponse}\n\n`,
            { line: cursor.line + 1, ch: 0 }
          );
        } catch (error) {
          new Notice(`❌ API调用失败: ${error.message}`);
          console.error(error);
        }
      },
    });

    // 添加设置选项卡（用于配置API密钥）
    this.addSettingTab(new AISettingsTab(this.app, this));
  }

  private async callOpenAI(input: string): Promise<string> {
    const messages = [];

    if (this.settings.systemPrompt) {
      messages.push({
        role: "system",
        content: this.settings.systemPrompt
      });
    }

    messages.push({ role: "user", content: input });

    const response = await axios.post(
      this.settings.apiUrl,
      {
        model: "internlm/internlm2_5-7b-chat",
        messages: messages
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.settings.apiKey}`
        }
      }
    );

    return response.data.choices[0].message.content;
  }

  private async loadSettings() {
    this.settings = Object.assign({}, this.settings, await this.loadData());
  }

  private async saveSettings() {
    await this.saveData(this.settings);
  }
}

class AISettingsTab extends PluginSettingTab {
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