import { useState, useCallback, useRef } from 'react'
import {
  Button,
  Card,
  Body1,
  Caption1,
  ProgressBar,
  makeStyles,
  shorthands,
} from '@fluentui/react-components'
import {
  CloudArrowUp24Regular,
  Image24Regular,
  Delete24Regular,
} from '@fluentui/react-icons'

const useStyles = makeStyles({
  dropZone: {
    ...shorthands.border('2px', 'dashed', '#d1d1d1'),
    ...shorthands.borderRadius('8px'),
    ...shorthands.padding('32px'),
    textAlign: 'center',
    cursor: 'pointer',
    backgroundColor: '#fafafa',
    transition: 'all 0.2s ease',
    '&:hover': {
      ...shorthands.borderColor('#0078d4'),
      backgroundColor: '#f3f9fd',
    },
  },
  dropZoneActive: {
    ...shorthands.borderColor('#0078d4'),
    backgroundColor: '#f3f9fd',
    ...shorthands.borderStyle('solid'),
  },
  fileList: {
    marginTop: '16px',
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.gap('8px'),
  },
  fileItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('12px'),
    backgroundColor: '#ffffff',
    ...shorthands.borderRadius('4px'),
    ...shorthands.border('1px', 'solid', '#e1e1e1'),
  },
  fileInfo: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    flex: '1',
  },
  fileProgress: {
    marginTop: '4px',
    width: '100%',
  },
  hiddenInput: {
    display: 'none',
  },
})

interface FileWithProgress {
  file: File
  progress: number
  status: 'pending' | 'uploading' | 'completed' | 'error'
  id: string
}

interface DragDropUploadProps {
  onFilesAdded?: (files: File[]) => void
  onUploadComplete?: (files: FileWithProgress[]) => void
  acceptedTypes?: string[]
  maxFileSize?: number // in MB
}

export default function DragDropUpload({
  onFilesAdded,
  onUploadComplete,
  acceptedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'],
  maxFileSize = 50
}: DragDropUploadProps) {
  const [isDragActive, setIsDragActive] = useState(false)
  const [files, setFiles] = useState<FileWithProgress[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const styles = useStyles()

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragIn = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragActive(true)
    }
  }, [])

  const handleDragOut = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragActive(false)
  }, [])

  const validateFile = (file: File): string | null => {
    if (!acceptedTypes.includes(file.type)) {
      return `File type ${file.type} is not supported. Please use: ${acceptedTypes.join(', ')}`
    }
    if (file.size > maxFileSize * 1024 * 1024) {
      return `File size ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds limit of ${maxFileSize}MB`
    }
    return null
  }

  const processFiles = (fileList: FileList | File[]) => {
    const validFiles: File[] = []
    const newFiles: FileWithProgress[] = []

    Array.from(fileList).forEach((file) => {
      const error = validateFile(file)
      if (error) {
        console.warn(`Skipping ${file.name}: ${error}`)
        return
      }

      validFiles.push(file)
      newFiles.push({
        file,
        progress: 0,
        status: 'pending',
        id: `${file.name}-${Date.now()}-${Math.random()}`
      })
    })

    if (newFiles.length > 0) {
      setFiles(prev => [...prev, ...newFiles])
      onFilesAdded?.(validFiles)
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files)
    }
  }, [acceptedTypes, maxFileSize, onFilesAdded])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files)
      // Reset input so same files can be selected again
      e.target.value = ''
    }
  }

  const uploadFiles = async () => {
    if (files.length === 0 || isUploading) return

    setIsUploading(true)
    const updatedFiles = [...files]

    for (let i = 0; i < updatedFiles.length; i++) {
      const fileWithProgress = updatedFiles[i]
      if (fileWithProgress.status !== 'pending') continue

      fileWithProgress.status = 'uploading'
      fileWithProgress.progress = 0
      setFiles([...updatedFiles])

      try {
        const formData = new FormData()
        formData.append('photo', fileWithProgress.file)

        // Simulate progress for better UX
        const progressInterval = setInterval(() => {
          fileWithProgress.progress = Math.min(fileWithProgress.progress + 10, 90)
          setFiles([...updatedFiles])
        }, 100)

        const response = await fetch('/api/photos/upload', {
          method: 'POST',
          body: formData,
        })

        clearInterval(progressInterval)

        if (response.ok) {
          const result = await response.json()
          fileWithProgress.status = 'completed'
          fileWithProgress.progress = 100
          console.log('Upload successful:', result)
        } else {
          const errorData = await response.json()
          fileWithProgress.status = 'error'
          console.error(`Upload failed for ${fileWithProgress.file.name}:`, errorData.message)
        }
      } catch (error) {
        fileWithProgress.status = 'error'
        console.error(`Upload error for ${fileWithProgress.file.name}:`, error)
      }

      setFiles([...updatedFiles])
    }

    setIsUploading(false)
    onUploadComplete?.(updatedFiles)
  }

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  const clearCompleted = () => {
    setFiles(prev => prev.filter(f => f.status !== 'completed'))
  }

  return (
    <div>
      <Card
        className={`${styles.dropZone} ${isDragActive ? styles.dropZoneActive : ''}`}
        onDragEnter={handleDragIn}
        onDragLeave={handleDragOut}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <CloudArrowUp24Regular style={{ fontSize: '48px', color: '#0078d4', marginBottom: '16px' }} />
        <Body1 style={{ marginBottom: '8px', fontWeight: 600 }}>
          Drop photos here or click to browse
        </Body1>
        <Caption1 style={{ color: '#757575' }}>
          Supports: JPEG, PNG, WebP, TIFF (max {maxFileSize}MB each)
        </Caption1>
      </Card>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={acceptedTypes.join(',')}
        onChange={handleFileSelect}
        className={styles.hiddenInput}
      />

      {files.length > 0 && (
        <div className={styles.fileList}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <Body1>{files.length} file(s) selected</Body1>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button
                size="small"
                appearance="subtle"
                onClick={clearCompleted}
                disabled={!files.some(f => f.status === 'completed')}
              >
                Clear Completed
              </Button>
              <Button
                size="small"
                appearance="primary"
                onClick={uploadFiles}
                disabled={isUploading || files.every(f => f.status === 'completed')}
              >
                {isUploading ? 'Uploading...' : 'Upload All'}
              </Button>
            </div>
          </div>

          {files.map((fileWithProgress) => (
            <div key={fileWithProgress.id} className={styles.fileItem}>
              <div className={styles.fileInfo}>
                <Image24Regular />
                <div style={{ flex: 1 }}>
                  <Body1>{fileWithProgress.file.name}</Body1>
                  <Caption1 style={{ color: '#757575' }}>
                    {(fileWithProgress.file.size / 1024 / 1024).toFixed(1)} MB • {fileWithProgress.status}
                  </Caption1>
                  {fileWithProgress.status === 'uploading' && (
                    <ProgressBar
                      className={styles.fileProgress}
                      value={fileWithProgress.progress}
                      max={100}
                    />
                  )}
                </div>
              </div>
              <Button
                size="small"
                appearance="subtle"
                icon={<Delete24Regular />}
                onClick={() => removeFile(fileWithProgress.id)}
                disabled={fileWithProgress.status === 'uploading'}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}