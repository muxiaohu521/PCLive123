<template>
  <div class="tool-setup">
    <div class="recording-param-group">
      <label class="param-label">录制质量</label>
      <el-select v-model="recordingQuality" class="param-select" placeholder="选择质量" size="default">
        <el-option label="高画质 (1080p)" value="high" />
        <el-option label="中等 (720p)" value="medium" />
        <el-option label="低画质 (480p)" value="low" />
      </el-select>
    </div>

    <div class="recording-param-group">
      <label class="param-label">输出目录</label>
      <div class="output-path-row">
        <input
          type="text"
          class="output-path-input"
          :value="recordingOutputPath || '默认：系统视频目录'"
          readonly
        />
        <button class="browse-btn" @click="selectOutputPath">浏览</button>
        <button class="browse-btn" @click="openRecordingFolder">打开目录</button>
      </div>
    </div>

    <div class="recording-info-hint">
      <p>录制已渲染的内容（当前激活的播放源），保存为通用 MP4 视频文件</p>
      <p>支持桌面窗口和全屏录制</p>
    </div>

    <div class="recording-controls">
      <el-button
        type="primary"
        class="start-record-btn"
        :disabled="recordState !== 'idle'"
        @click="startRecording"
      >
        {{ recordState === 'idle' ? '开始录屏' : '录屏进行中' }}
      </el-button>
      <el-button
        v-if="recordState !== 'idle'"
        type="danger"
        class="start-record-btn"
        @click="stopRecording"
      >
        停止录屏
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRecording } from './useRecording'

const {
  recordingQuality,
  recordingOutputPath,
  recordState,
  selectOutputPath,
  openRecordingFolder,
  startRecording,
  stopRecording,
} = useRecording()
</script>

<style scoped>
.recording-controls {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 8px;
}
</style>