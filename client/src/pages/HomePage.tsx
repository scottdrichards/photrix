import { useState, useEffect } from 'react'
import { 
  Button,
  ToggleButton,
  Card,
  Text,
  Title2,
  Subtitle1,
  Body1,
  Field,
  Input,
  Checkbox,
  makeStyles,
  shorthands
} from '@fluentui/react-components'
import { 
  GridDots24Regular,
  List24Regular,
  CloudArrowUp24Regular,
  Camera24Regular,
  Filter24Regular
} from '@fluentui/react-icons'
import DragDropUpload from '../components/DragDropUpload'

interface Photo {
  id: string
  filename: string
  originalName: string
  size: number
  mimetype: string
  uploadDate: string
  url: string
  thumbnailUrl?: string
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    ...shorthands.overflow('hidden'),
  },
  filtersSection: {
    ...shorthands.padding('16px', '24px'),
    backgroundColor: '#fafafa',
    ...shorthands.borderBottom('1px', 'solid', '#e1e1e1'),
  },
  filtersContainer: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    ...shorthands.gap('16px'),
    alignItems: 'end',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('16px', '24px'),
    ...shorthands.borderBottom('1px', 'solid', '#e1e1e1'),
    backgroundColor: '#ffffff',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
  },
  viewToggle: {
    display: 'flex',
  },
  mainContent: {
    flex: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...shorthands.padding('48px', '24px'),
    ...shorthands.overflow('auto'),
  },
  emptyState: {
    textAlign: 'center',
    maxWidth: '600px',
    width: '100%',
  },
  emptyIcon: {
    fontSize: '64px',
    color: '#d1d1d1',
    marginBottom: '16px',
  },
  uploadSection: {
    maxWidth: '600px',
    width: '100%',
  },
  detailsSection: {
    ...shorthands.padding('16px', '24px'),
    backgroundColor: '#fafafa',
    ...shorthands.borderTop('1px', 'solid', '#e1e1e1'),
    minHeight: '120px',
  },
  photoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    ...shorthands.gap('16px'),
    ...shorthands.padding('16px'),
  },
  photoCard: {
    ...shorthands.borderRadius('8px'),
    ...shorthands.overflow('hidden'),
    cursor: 'pointer',
    transition: 'transform 0.2s ease',
    '&:hover': {
      transform: 'scale(1.02)',
    },
  },
  photoImage: {
    width: '100%',
    height: '200px',
    objectFit: 'cover',
  },
  photoInfo: {
    ...shorthands.padding('8px'),
  },
})

export default function HomePage() {
  const [isFiltersVisible, setIsFiltersVisible] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [showUploadArea, setShowUploadArea] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const styles = useStyles()

  // Fetch photos from server
  const fetchPhotos = async () => {
    try {
      setIsLoading(true)
      const response = await fetch('/api/photos')
      if (response.ok) {
        const data = await response.json()
        setPhotos(data.photos || [])
      } else {
        console.error('Failed to fetch photos')
      }
    } catch (error) {
      console.error('Error fetching photos:', error)
    } finally {
      setIsLoading(false)
    }
  }

  // Fetch photos on component mount
  useEffect(() => {
    fetchPhotos()
  }, [])

  const handleFilesAdded = (files: File[]) => {
    console.log('Files added for upload:', files.map(f => f.name))
  }

  const handleUploadComplete = (files: any[]) => {
    const completedFiles = files.filter(f => f.status === 'completed')
    console.log('Upload completed:', completedFiles.length, 'files')
    // Refresh photos after upload
    if (completedFiles.length > 0) {
      fetchPhotos()
    }
  }

  const handleUploadClick = () => {
    setShowUploadArea(true)
  }

  return (
    <div className={styles.root}>
      {/* Filters Section - Horizontal at top */}
      {isFiltersVisible && (
        <section className={styles.filtersSection}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <Subtitle1>Filters</Subtitle1>
            <Button
              appearance="subtle"
              size="small"
              onClick={() => setIsFiltersVisible(false)}
            >
              ✕
            </Button>
          </div>
          
          <div className={styles.filtersContainer}>
            <Field label="Date Range">
              <Input type="date" size="small" />
            </Field>
            
            <Field label="Tags">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <Checkbox label="Favorites" />
                <Checkbox label="People" />
              </div>
            </Field>
            
            <Field label="Location">
              <Card style={{ height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Body1 style={{ color: '#757575' }}>Map View (To be implemented)</Body1>
              </Card>
            </Field>
          </div>
        </section>
      )}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          {!isFiltersVisible && (
            <Button
              appearance="subtle"
              icon={<Filter24Regular />}
              onClick={() => setIsFiltersVisible(true)}
            >
              Show Filters
            </Button>
          )}
          <Text size={300}>{photos.length} photos</Text>
        </div>
        
        <div className={styles.toolbarRight}>
          <Button
            appearance="primary"
            icon={<CloudArrowUp24Regular />}
            onClick={handleUploadClick}
          >
            Upload Photos
          </Button>
          
          <div className={styles.viewToggle}>
            <ToggleButton
              checked={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
              icon={<GridDots24Regular />}
              aria-label="Grid view"
            />
            <ToggleButton
              checked={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              icon={<List24Regular />}
              aria-label="List view"
            />
          </div>
        </div>
      </div>

      {/* Main Photo Area */}
      <div className={styles.mainContent}>
        {isLoading ? (
          <div style={{ textAlign: 'center' }}>
            <Body1>Loading photos...</Body1>
          </div>
        ) : photos.length === 0 && !showUploadArea ? (
          <div className={styles.emptyState}>
            <Camera24Regular className={styles.emptyIcon} />
            <Title2 style={{ marginBottom: '8px' }}>No photos yet</Title2>
            <Body1 style={{ marginBottom: '24px', color: '#757575' }}>
              Upload your first photos to get started
            </Body1>
            <Button
              appearance="primary"
              size="large"
              icon={<CloudArrowUp24Regular />}
              onClick={handleUploadClick}
            >
              Upload Photos
            </Button>
          </div>
        ) : (
          <div className={styles.uploadSection}>
            {showUploadArea && (
              <>
                <div style={{ marginBottom: '24px', textAlign: 'center' }}>
                  <Title2 style={{ marginBottom: '8px' }}>Upload Photos</Title2>
                  <Body1 style={{ color: '#757575' }}>
                    Drag and drop your photos or click to browse
                  </Body1>
                </div>
                <DragDropUpload
                  onFilesAdded={handleFilesAdded}
                  onUploadComplete={handleUploadComplete}
                />
                {photos.length === 0 && (
                  <div style={{ textAlign: 'center', marginTop: '16px' }}>
                    <Button
                      appearance="subtle"
                      onClick={() => setShowUploadArea(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </>
            )}
            
            {photos.length > 0 && !showUploadArea && (
              <>
                {viewMode === 'grid' ? (
                  <div className={styles.photoGrid}>
                    {photos.map((photo) => (
                      <Card key={photo.id} className={styles.photoCard}>
                        <img
                          src={photo.thumbnailUrl || photo.url}
                          alt={photo.originalName}
                          className={styles.photoImage}
                          loading="lazy"
                        />
                        <div className={styles.photoInfo}>
                          <Body1 style={{ fontSize: '12px', fontWeight: 600 }}>
                            {photo.originalName}
                          </Body1>
                          <Body1 style={{ fontSize: '10px', color: '#757575' }}>
                            {(photo.size / 1024 / 1024).toFixed(1)} MB
                          </Body1>
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: '16px' }}>
                    {photos.map((photo) => (
                      <Card key={photo.id} style={{ marginBottom: '8px', padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <img
                          src={photo.thumbnailUrl || photo.url}
                          alt={photo.originalName}
                          style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '4px' }}
                        />
                        <div style={{ flex: 1 }}>
                          <Body1 style={{ fontWeight: 600 }}>{photo.originalName}</Body1>
                          <Body1 style={{ fontSize: '12px', color: '#757575' }}>
                            {(photo.size / 1024 / 1024).toFixed(1)} MB • {photo.mimetype} • {new Date(photo.uploadDate).toLocaleDateString()}
                          </Body1>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
                
                <div style={{ textAlign: 'center', padding: '16px' }}>
                  <Button
                    appearance="primary"
                    icon={<CloudArrowUp24Regular />}
                    onClick={() => setShowUploadArea(true)}
                  >
                    Upload More Photos
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Details Section - Bottom */}
      <section className={styles.detailsSection}>
        <Subtitle1 style={{ marginBottom: '8px' }}>Photo Details</Subtitle1>
        <Body1 style={{ color: '#757575' }}>
          {showUploadArea 
            ? 'Select files to upload' 
            : photos.length > 0 
              ? `Showing ${photos.length} photo${photos.length === 1 ? '' : 's'}`
              : 'No photos to display'
          }
        </Body1>
      </section>
    </div>
  )
}