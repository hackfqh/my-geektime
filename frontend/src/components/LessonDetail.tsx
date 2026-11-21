import React, { useEffect, useState, useRef, useCallback } from 'react'
import { X, ExternalLink, FileText, ChevronLeft, ChevronRight, Maximize2, Rocket, MessageCircle, ThumbsUp } from 'lucide-react'
import { getTaskInfo, getArticleComments, getCommentDiscussions, type TaskInfoResponse } from '@/api/task'
import type Hls from 'hls.js'

interface LessonDetailProps {
  show: boolean
  taskId: string | null
  lessonList: any[]
  currentIndex: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
}

export const LessonDetail: React.FC<LessonDetailProps> = ({
  show,
  taskId,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) => {
  const [loading, setLoading] = useState(false)
  const [taskInfoResponse, setTaskInfoResponse] = useState<TaskInfoResponse | null>(null)
  const taskInfo = taskInfoResponse?.task || null
  const article = taskInfoResponse?.article || null
  const playUrl = taskInfoResponse?.play_url
  const [localAudioFailed, setLocalAudioFailed] = useState(false)
  const downloadedObject = taskInfoResponse?.message?.object
  // The storage API returns an unescaped file path, including any literal # in the filename.
  const localAudioPath = downloadedObject?.toLowerCase().endsWith('.mp3')
    ? new URL(encodeURI(downloadedObject).replace(/#/g, '%23'), window.location.origin).pathname
    : null
  const isAudio = !taskInfo?.is_video && !article?.video?.hls_medias?.length &&
    !article?.video_preview?.medias?.length && Boolean(localAudioPath || article?.audio?.url)
  const useLocalAudio = isAudio && localAudioPath !== null && !localAudioFailed
  const [showFloatingPlayer, setShowFloatingPlayer] = useState(false)
  const [floatingPosition, setFloatingPosition] = useState({ x: 20, y: 80 })
  const [floatingSize, setFloatingSize] = useState({ width: 300, height: 220 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isResizing, setIsResizing] = useState(false)
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const [drawerWidth, setDrawerWidth] = useState<number>(1024) // max-w-4xl = 1024px
  const isDrawerResizing = useRef(false)
  const drawerResizeStartX = useRef(0)
  const drawerResizeStartWidth = useRef(0)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [videoState, setVideoState] = useState({ currentTime: 0, isPlaying: false })
  const [comments, setComments] = useState<any[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsPage, setCommentsPage] = useState(1)
  const [commentsHasMore, setCommentsHasMore] = useState(false)
  const [commentsTotal, setCommentsTotal] = useState(0)
  const [expandedDiscussions, setExpandedDiscussions] = useState<Set<string>>(new Set())
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const floatingPlayerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const setMediaRef = useCallback((element: HTMLMediaElement | null) => {
    mediaRef.current = element
  }, [])
  const prevTaskIdRef = useRef<string | null>(null)

  const loadComments = async (aid: string, page: number) => {
    console.log('loadComments called:', aid, page)
    try {
      setCommentsLoading(true)
      const res: any = await getArticleComments({ aid, page, perPage: 5 })
      console.log('comments response:', res)
      const items = res?.rows || res?.items || res?.data?.rows || res?.data?.items || []
      const total = res?.count || res?.total || 0
      console.log('comments items:', items)
      if (page === 1) {
        setComments(items)
      } else {
        setComments(prev => [...prev, ...items])
      }
      setCommentsTotal(total)
      setCommentsHasMore(items.length >= 5)
      setCommentsPage(page)
    } catch (err) {
      console.error('获取评论失败', err)
    } finally {
      setCommentsLoading(false)
    }
  }

  const toggleDiscussions = async (commentId: string) => {
    const newExpanded = new Set(expandedDiscussions)
    if (newExpanded.has(commentId)) {
      newExpanded.delete(commentId)
      setExpandedDiscussions(newExpanded)
    } else {
      newExpanded.add(commentId)
      setExpandedDiscussions(newExpanded)
      await loadDiscussionsForComment(commentId, 1)
    }
  }

  const loadDiscussionsForComment = async (commentId: string, page: number) => {
    try {
      setComments(prev => prev.map(c => {
        if (c.id === commentId) {
          return { ...c, discussionsLoading: true }
        }
        return c
      }))
      const res: any = await getCommentDiscussions({
        target_id: commentId,
        target_type: 1,
        page,
        perPage: 10,
        use_likes_order: true
      })
      const items = res?.rows || res?.items || res?.data?.rows || res?.data?.items || []
      const hasMore = items.length >= 10
      setComments(prev => prev.map(c => {
        if (c.id === commentId) {
          const existingDiscussions = page === 1 ? [] : (c.discussions || [])
          return {
            ...c,
            discussions: [...existingDiscussions, ...items],
            discussionsPage: page,
            discussionsHasMore: hasMore,
            discussionsLoading: false
          }
        }
        return c
      }))
    } catch (err) {
      console.error('获取讨论失败', err)
      setComments(prev => prev.map(c => {
        if (c.id === commentId) {
          return { ...c, discussionsLoading: false }
        }
        return c
      }))
    }
  }

  const loadMoreDiscussions = (commentId: string) => {
    const comment = comments.find(c => c.id === commentId)
    if (comment) {
      loadDiscussionsForComment(commentId, (comment.discussionsPage || 1) + 1)
    }
  }

  useEffect(() => {
    console.log('LessonDetail useEffect - show:', show, 'taskId:', taskId)
    if (show && taskId) {
      // 检查是否已经加载过相同的数据
      if (prevTaskIdRef.current === taskId) {
        console.log('Skipping duplicate load for taskId:', taskId)
        return
      }
      
      prevTaskIdRef.current = taskId
      setLoading(true)
      setLocalAudioFailed(false)
      setShowFloatingPlayer(false)
      setShowScrollTop(false)
      setComments([])
      setCommentsPage(1)
      if (contentRef.current) {
        contentRef.current.scrollTop = 0
      }
      if (mediaRef.current) {
        mediaRef.current.currentTime = 0
        mediaRef.current.pause()
      }
      getTaskInfo(taskId)
        .then((data) => {
          setTaskInfoResponse(data)
          const otherId = data.task?.other_id || data.article?.other_id || data.article?.id
          if (otherId) {
            loadComments(otherId, 1)
          }
        })
        .catch((err) => {
          console.error('获取章节详情失败', err)
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [show, taskId])

  useEffect(() => {
    const contentElement = contentRef.current
    if (!contentElement) return

    const handleScroll = () => {
      const container = videoContainerRef.current
      if (!container) return

      if (!isAudio) {
        const { bottom } = container.getBoundingClientRect()
        if (bottom < 100) {
          setShowFloatingPlayer(true)
        } else if (bottom > 200) {
          setShowFloatingPlayer(false)
        }
      }

      setShowScrollTop(contentElement.scrollTop > 300)
    }

    contentElement.addEventListener('scroll', handleScroll)
    return () => contentElement.removeEventListener('scroll', handleScroll)
  }, [isAudio, show, taskInfo])

  const scrollToTop = () => {
    if (contentRef.current) {
      contentRef.current.scrollTo({
        top: 0,
        behavior: 'smooth'
      })
      if (showFloatingPlayer) {
        saveVideoState()
        setTimeout(() => {
          setShowFloatingPlayer(false)
        }, 0)
      }
    }
  }

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!floatingPlayerRef.current) return
    setIsDragging(true)
    const rect = floatingPlayerRef.current.getBoundingClientRect()
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    })
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDragging) {
      const newX = e.clientX - dragOffset.x
      const newY = e.clientY - dragOffset.y
      
      const maxX = window.innerWidth - floatingSize.width - 20
      const maxY = window.innerHeight - floatingSize.height - 20
      
      setFloatingPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY))
      })
    }
    
    if (isResizing) {
      const deltaX = e.clientX - resizeStart.x
      const deltaY = e.clientY - resizeStart.y
      
      const newWidth = Math.max(200, Math.min(600, resizeStart.width + deltaX))
      const newHeight = Math.max(150, Math.min(500, resizeStart.height + deltaY))
      
      setFloatingSize({ width: newWidth, height: newHeight })
    }
  }, [isDragging, dragOffset, isResizing, resizeStart, floatingSize])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
    setIsResizing(false)
  }, [])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: floatingSize.width,
      height: floatingSize.height
    })
  }, [floatingSize])

  const handleDrawerResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDrawerResizing.current = true
    drawerResizeStartX.current = e.clientX
    drawerResizeStartWidth.current = drawerWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDrawerResizing.current) return
      const deltaX = drawerResizeStartX.current - moveEvent.clientX // 从左侧拖动，所以是反向
      const newWidth = drawerResizeStartWidth.current + deltaX
      const minWidth = 600
      const maxWidth = window.innerWidth * 0.9
      setDrawerWidth(Math.min(maxWidth, Math.max(minWidth, newWidth)))
    }

    const handleMouseUp = () => {
      isDrawerResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [drawerWidth])

  useEffect(() => {
    if (isDragging || isResizing || isDrawerResizing.current) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDragging, isResizing, handleMouseMove, handleMouseUp])

  const prevFloatingRef = useRef(showFloatingPlayer)
  const hlsRef = useRef<Hls | null>(null)
  
  useEffect(() => {
    if (prevFloatingRef.current !== showFloatingPlayer) {
      const video = mediaRef.current
      if (video) {
        video.currentTime = videoState.currentTime
        if (videoState.isPlaying) {
          video.play().catch(() => {})
        }
      }
      prevFloatingRef.current = showFloatingPlayer
    }
  }, [showFloatingPlayer, videoState])

  const saveVideoState = useCallback(() => {
    const video = mediaRef.current
    if (video) {
      setVideoState({
        currentTime: video.currentTime,
        isPlaying: !video.paused
      })
    }
  }, [])

  const handleVideoTimeUpdate = useCallback(() => {
    const video = mediaRef.current
    if (video) {
      setVideoState(prev => ({
        ...prev,
        currentTime: video.currentTime
      }))
    }
  }, [])

  const handleVideoPlay = useCallback(() => {
    setVideoState(prev => ({ ...prev, isPlaying: true }))
  }, [])

  const handleVideoPause = useCallback(() => {
    setVideoState(prev => ({ ...prev, isPlaying: false }))
  }, [])

  const scrollToVideo = () => {
    if (videoContainerRef.current && contentRef.current) {
      contentRef.current.scrollTo({
        top: 0,
        behavior: 'smooth'
      })
      handleFloatingToggle(false)
    }
  }

  const getMediaSrc = () => {
    if (!taskInfo) return null
    if (useLocalAudio) return localAudioPath
    if (playUrl) {
      if (isAudio) {
        const { pathname, search } = new URL(playUrl, window.location.origin)
        if (pathname === '/v2/task/play.m3u8') return pathname + search
      }
      return playUrl
    }
    if (article?.video?.hls_medias?.length) {
      const last = article.video.hls_medias[article.video.hls_medias.length - 1]
      return last.url
    }
    if (article?.video_preview?.medias?.length) {
      const last = article.video_preview.medias[article.video_preview.medias.length - 1]
      return last.url
    }
    if (article?.audio?.url) return article.audio.url
    return null
  }

  const mediaSrc = getMediaSrc()
  const poster = article?.cover?.default
  
  useEffect(() => {
    const video = mediaRef.current
    if (!video || !mediaSrc || useLocalAudio) return
    let active = true
    
    console.log('Initializing video player with src:', mediaSrc)
    
    const destroyHls = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
    
    destroyHls()
    
    const initHls = async () => {
      if (!mediaSrc.includes('.m3u8')) {
        console.log('Non-HLS video, setting src directly')
        video.src = mediaSrc
        return
      }
      
      if (isAudio && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = mediaSrc
        return
      }

      console.log('HLS video detected')
      
      try {
        const HlsModule = await import('hls.js')
        if (!active) return
        const Hls = HlsModule.default
        
        if (Hls.isSupported()) {
          console.log('Using hls.js for playback')
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            debug: false
          })
          hlsRef.current = hls
          
          hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            console.error('HLS error:', data.type, data.details, data)
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.error('Fatal network error, trying to recover...')
                  hls.startLoad()
                  break
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.error('Fatal media error, trying to recover...')
                  hls.recoverMediaError()
                  break
                default:
                  console.error('Fatal error, cannot recover')
                  destroyHls()
                  break
              }
            }
          })
          
          hls.loadSource(mediaSrc)
          hls.attachMedia(video)
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS manifest loaded successfully')
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // 如果 hls.js 不支持（比如 Safari），再尝试原生 HLS
          console.warn('hls.js not supported, falling back to native HLS')
          video.src = mediaSrc
        } else {
          console.error('No HLS support in this browser')
        }
      } catch (err) {
        console.error('Failed to load hls.js:', err)
        // 如果 hls.js 加载失败，尝试原生 HLS
        if (active && video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = mediaSrc
        }
      }
    }
    
    initHls()
    
    return () => {
      active = false
      destroyHls()
    }
  }, [mediaSrc, isAudio, useLocalAudio, showFloatingPlayer, loading, show])

  if (!show) return null

  const renderScrollTopButton = () => {
    if (!showScrollTop) return null

    return (
      <button
        onClick={scrollToTop}
        className="fixed bottom-8 right-8 w-12 h-12 rounded-full bg-white text-primary-600 border-2 border-primary-300 shadow-lg hover:bg-primary-50 hover:border-primary-400 transition-all duration-300 flex items-center justify-center z-[95] hover:scale-110"
        title="返回顶部"
      >
        <Rocket size={20} />
      </button>
    )
  }

  const handleFloatingToggle = (newState: boolean) => {
    saveVideoState()
    setTimeout(() => {
      setShowFloatingPlayer(newState)
    }, 0)
  }

  const renderMediaControls = (videoClassName: string) => {
    const controls = {
      ref: setMediaRef,
      controls: true,
      onTimeUpdate: handleVideoTimeUpdate,
      onPlay: handleVideoPlay,
      onPause: handleVideoPause,
    }

    if (isAudio) {
      return (
        <audio
          {...controls}
          className="w-full"
          preload="metadata"
          src={useLocalAudio ? localAudioPath : undefined}
          onError={useLocalAudio ? () => setLocalAudioFailed(true) : undefined}
        />
      )
    }

    return <video {...controls} poster={poster} className={videoClassName} />
  }

  const renderVideoPlayer = () => {
    if (!mediaSrc) return null

    if (showFloatingPlayer) {
      return (
        <div
          ref={floatingPlayerRef}
          className="fixed z-[100] bg-white rounded-lg shadow-2xl overflow-hidden cursor-move"
          style={{
            left: floatingPosition.x,
            top: floatingPosition.y,
            width: floatingSize.width,
            height: floatingSize.height,
          }}
          onMouseDown={handleMouseDown}
        >
          <div className="bg-gray-800 text-white px-3 py-2 flex items-center justify-between">
            <span className="text-sm font-medium truncate flex-1">
              {taskInfo?.task_name || '播放中'}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={scrollToVideo}
                className="p-1 hover:bg-white/20 rounded transition-colors"
                title="返回原位置"
              >
                <Maximize2 size={14} />
              </button>
              <button
                onClick={() => handleFloatingToggle(false)}
                className="p-1 hover:bg-white/20 rounded transition-colors"
                title="关闭"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="w-full bg-black flex items-center justify-center" style={{ height: 'calc(100% - 40px)' }}>
            {renderMediaControls('w-full h-full object-contain')}
          </div>
          <div
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
            style={{
              background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.3) 50%)',
            }}
            onMouseDown={handleResizeStart}
            title="拖动调整大小"
          />
        </div>
      )
    }

    return (
      <div
        ref={videoContainerRef}
        className={`flex justify-center bg-gray-100 p-4 ${
          isAudio ? 'sticky top-0 z-30 -mx-4 -mt-4' : 'rounded-lg'
        }`}
      >
        <div className={isAudio ? 'w-full' : 'max-w-full max-h-[50vh] rounded-lg overflow-hidden bg-black'}>
          {renderMediaControls('max-w-full max-h-[50vh] rounded-lg')}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[80]">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[80]"
        onClick={onClose}
      />
      {renderScrollTopButton()}
      
      {mediaSrc && showFloatingPlayer && renderVideoPlayer()}

      <div 
        className="fixed right-0 top-0 h-full max-w-full bg-white shadow-2xl overflow-hidden z-[90] transition-all duration-300 ease-in-out"
        style={{ width: drawerWidth }}
      >
        {/* 左侧拖拽手柄 */}
        <div
          className="hidden lg:block absolute left-0 top-0 bottom-0 w-4 cursor-col-resize hover:bg-primary-500/20 transition-colors group active:cursor-col-resize z-10"
          onMouseDown={handleDrawerResizeStart}
          title="拖动调整宽度"
        >
          <div className="absolute left-1 top-1/2 -translate-y-1/2 w-1 h-8 bg-gray-300 group-hover:bg-primary-500 rounded-full transition-colors" />
        </div>
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-primary-100 bg-gradient-to-r from-primary-50 to-primary-100">
            <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <h3 className="font-semibold text-gray-800">
                {taskInfo?.task_name || '加载中...'}
              </h3>
              {article?.summary && (
                <p className="text-sm text-gray-500 mt-1">{article.summary}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="ml-4 shrink-0 rounded-lg p-2 transition-colors hover:bg-white/50"
            >
              <X size={20} className="text-gray-500" />
            </button>
          </div>

          <div ref={contentRef} className="flex-1 overflow-y-auto p-4 max-lg:overflow-x-hidden max-lg:overscroll-x-none">
            {loading ? (
              <div className="flex justify-center py-20">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500" />
              </div>
            ) : taskInfo ? (
              <div className="space-y-4">
                {mediaSrc && !showFloatingPlayer && renderVideoPlayer()}
                {mediaSrc && showFloatingPlayer && (
                  <div className="bg-gray-100 rounded-lg p-4 flex justify-center">
                    <div className="w-full max-w-full h-[300px] bg-gray-200 rounded-lg flex items-center justify-center">
                      <span className="text-gray-400">{isAudio ? '音频' : '视频'}正在浮动窗口播放</span>
                    </div>
                  </div>
                )}
                {!mediaSrc && (
                  <div ref={videoContainerRef} className="bg-gray-100 rounded-lg p-4 flex justify-center">
                    <div className="w-full max-w-full h-[300px] bg-gray-200 rounded-lg flex items-center justify-center">
                      <span className="text-gray-400">无视频</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 justify-center">
                  {taskInfo?.redirect && (
                    <div className="relative group">
                      <a
                        href={taskInfo.redirect}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-sm"
                      >
                        <ExternalLink size={14} />
                      </a>
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20">
                        查看源站
                      </div>
                    </div>
                  )}
                  <div className="relative group">
                    <a
                      href={`/v2/task/download?id=${taskId}&type=markdown`}
                      className="flex items-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors text-sm"
                    >
                      <FileText size={14} />
                    </a>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20">
                      导出Markdown
                    </div>
                  </div>
                  {hasPrev && (
                    <div className="relative group">
                      <button
                        onClick={onPrev}
                        className="flex items-center gap-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors text-sm"
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20">
                        上一个
                      </div>
                    </div>
                  )}
                  {hasNext && (
                    <div className="relative group">
                      <button
                        onClick={onNext}
                        className="flex items-center gap-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors text-sm"
                      >
                        <ChevronRight size={14} />
                      </button>
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20">
                        下一个
                      </div>
                    </div>
                  )}
                </div>

                {article?.content && (
                  <div
                    className="article-content bg-white rounded-lg p-4 border border-gray-100"
                    dangerouslySetInnerHTML={{ __html: article.content }}
                  />
                )}

                <div className="mt-6">
                  <div className="flex items-center gap-2 mb-4">
                    <MessageCircle size={18} className="text-primary-500" />
                    <h4 className="font-semibold text-gray-800">评论列表</h4>
                    <span className="text-sm text-gray-500">({commentsTotal})</span>
                  </div>
                  
                  {commentsLoading && comments.length === 0 ? (
                    <div className="flex justify-center py-8">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-500" />
                    </div>
                  ) : comments.length === 0 ? (
                    <div className="text-center py-8 text-gray-400">暂无评论</div>
                  ) : (
                    <div className="space-y-4">
                      {comments.map((comment: any) => (
                        <div key={comment.id} className="bg-gray-50 rounded-lg p-4">
                          <div className="flex items-start gap-3">
                            <img
                              src={comment.user_header}
                              alt={comment.user_name}
                              className="w-10 h-10 rounded-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src = 'https://via.placeholder.com/40'
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-gray-800">{comment.user_name}</span>
                                {comment.discussion_count > 0 && (
                                  <span className="text-xs text-gray-500">{comment.discussion_count}讨论</span>
                                )}
                                {comment.like_count > 0 && (
                                  <span className="text-xs text-gray-500">{comment.like_count}赞</span>
                                )}
                              </div>
                              <div
                                className="mt-2 text-sm text-gray-600 word-break"
                                dangerouslySetInnerHTML={{ __html: comment.comment_content }}
                              />
                              {comment.discussion_count > 0 && (
                                <div className="mt-3">
                                  <button
                                    onClick={() => toggleDiscussions(comment.id)}
                                    className="text-xs text-primary-500 hover:text-primary-600 flex items-center gap-1"
                                  >
                                    {expandedDiscussions.has(comment.id) ? '收起' : '展开'} ({comment.discussion_count})
                                  </button>
                                  {expandedDiscussions.has(comment.id) && (
                                    <div className="mt-3 space-y-3 pl-4 border-l-2 border-purple-200">
                                      {comment.discussions?.map((discussion: any) => (
                                        <div key={discussion.discussion?.id || discussion.id}>
                                          <div className="flex gap-3">
                                            <img
                                              src={discussion.author?.avatar}
                                              alt={discussion.author?.nickname}
                                              className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                                              onError={(e) => {
                                                (e.target as HTMLImageElement).src = 'https://via.placeholder.com/32'
                                              }}
                                            />
                                            <div className="flex-1 min-w-0 bg-white rounded-lg p-3 border border-gray-100">
                                              <div className="flex items-center gap-2 mb-2">
                                                <span className="text-sm font-medium text-gray-800">{discussion.author?.nickname}</span>
                                                <span className="text-xs text-gray-400">
                                                  {discussion.discussion?.ctime ? new Date(discussion.discussion.ctime * 1000).toLocaleDateString() : ''}
                                                </span>
                                                {discussion.discussion?.likes_number > 0 && (
                                                  <span className="flex items-center gap-1 text-xs text-gray-500 ml-auto">
                                                    <ThumbsUp size={10} />
                                                    {discussion.discussion?.likes_number}
                                                  </span>
                                                )}
                                              </div>
                                              <div
                                                className="text-sm text-gray-600 word-break"
                                                dangerouslySetInnerHTML={{ __html: discussion.discussion?.discussion_content || '' }}
                                              />
                                            </div>
                                          </div>
                                          {discussion.child_discussions?.length > 0 && (
                                            <div className="mt-3 ml-11 space-y-3">
                                              {discussion.child_discussions.map((child: any) => (
                                                <div key={child.discussion?.id || child.id} className="flex gap-3">
                                                  <img
                                                    src={child.author?.avatar}
                                                    alt={child.author?.nickname}
                                                    className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                                                    onError={(e) => {
                                                      (e.target as HTMLImageElement).src = 'https://via.placeholder.com/24'
                                                    }}
                                                  />
                                                  <div className="flex-1 min-w-0 bg-gray-50 rounded-lg p-2 border border-gray-100">
                                                    <div className="flex items-center gap-2 mb-1">
                                                      <span className="text-xs font-medium text-gray-700">{child.author?.nickname}</span>
                                                      {child.reply_author?.nickname && (
                                                        <span className="text-xs text-gray-400">
                                                          回复 {child.reply_author.nickname}
                                                        </span>
                                                      )}
                                                      <span className="text-xs text-gray-400">
                                                        {child.discussion?.ctime ? new Date(child.discussion.ctime * 1000).toLocaleDateString() : ''}
                                                      </span>
                                                    </div>
                                                    <div
                                                      className="text-xs text-gray-600 word-break"
                                                      dangerouslySetInnerHTML={{ __html: child.discussion?.discussion_content || '' }}
                                                    />
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                      {comment.discussionsHasMore && (
                                        <div className="text-center pl-11">
                                          <button
                                            onClick={() => loadMoreDiscussions(comment.id)}
                                            disabled={comment.discussionsLoading}
                                            className="px-3 py-1 text-xs text-primary-500 hover:text-primary-600 disabled:opacity-50"
                                          >
                                            {comment.discussionsLoading ? '加载中...' : '加载更多'}
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      
                      {commentsHasMore && (
                        <div className="text-center pt-2">
                          <button
                            onClick={() => {
                              const aid = taskInfo?.other_id || article?.other_id || article?.id
                              if (aid) {
                                loadComments(String(aid), commentsPage + 1)
                              }
                            }}
                            disabled={commentsLoading}
                            className="px-4 py-2 text-sm text-primary-500 hover:text-primary-600 disabled:opacity-50"
                          >
                            {commentsLoading ? '加载中...' : '加载更多'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {taskInfoResponse?.message?.text && (
                  <div className="mt-6 p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                    <p className="text-sm text-yellow-800 whitespace-pre-wrap">
                      {taskInfoResponse.message.text.includes('failed') || taskInfoResponse.message.text.includes('error') 
                        ? '错误：' + taskInfoResponse.message.text 
                        : '提示：' + taskInfoResponse.message.text}
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
