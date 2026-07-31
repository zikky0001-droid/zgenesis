// ============================================
// THE GENESIS - FRONTEND LOGIC
// By Dev Zikky Tech
// ============================================

// ============== STATE ==============
const state = {
    videos: [],
    currentPage: 1,
    isLoading: false,
    hasMore: true,
    searchQuery: '',
    currentGenre: 'all',
    currentVideo: null
};

// ============== DOM REFS WITH NULL CHECKS ==============
function getElement(id) {
    const el = document.getElementById(id);
    if (!el) {
        console.warn(`⚠️ Element #${id} not found`);
    }
    return el;
}

function getElements(selector) {
    const els = document.querySelectorAll(selector);
    if (!els || els.length === 0) {
        console.warn(`⚠️ No elements found for selector: ${selector}`);
    }
    return els;
}

const DOM = {
    results: getElement('results'),
    loading: getElement('loading'),
    endResults: getElement('endResults'),
    searchInput: getElement('searchInput'),
    searchBtn: getElement('searchBtn'),
    resultsCount: getElement('resultsCount'),
    backToTop: getElement('backToTop'),
    themeToggle: getElement('themeToggle'),
    menuToggle: getElement('menuToggle'),
    navLinks: getElement('navLinks'),
    toastContainer: getElement('toastContainer'),
    genreFilters: getElement('genreFilters')
};

// ============== API BASE ==============
const API_BASE = window.location.origin;

// ============== CHECK IF ON VIDEO PAGE ==============
const isVideoPage = !!getElement('videoPage');

// ============== INIT ==============
document.addEventListener('DOMContentLoaded', () => {
    if (isVideoPage) {
        setupVideoPage();
    } else {
        setupHomepage();
    }
    
    setupGlobalListeners();
    loadTheme();
});

// ============== SETUP HOMEPAGE ==============
function setupHomepage() {
    loadVideos();
    setupHomepageListeners();
    setupScroll();
}

// ============== SETUP VIDEO PAGE ==============
function setupVideoPage() {
    const params = new URLSearchParams(window.location.search);
    const videoId = params.get('id');
    
    if (videoId) {
        loadVideoDetails(videoId);
    } else {
        showToast('No video selected', 'error');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 2000);
    }
}

// ============== SETUP HOMEPAGE LISTENERS ==============
function setupHomepageListeners() {
    // Search
    if (DOM.searchBtn) {
        DOM.searchBtn.addEventListener('click', performSearch);
    }
    if (DOM.searchInput) {
        DOM.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });
    }
    
    // Genre Filters
    if (DOM.genreFilters) {
        const filterBtns = DOM.genreFilters.querySelectorAll('.filter-btn');
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.currentGenre = btn.dataset.genre;
                state.currentPage = 1;
                state.hasMore = true;
                state.videos = [];
                if (DOM.results) DOM.results.innerHTML = '';
                if (DOM.endResults) DOM.endResults.style.display = 'none';
                loadVideos();
            });
        });
    }
}

// ============== SETUP GLOBAL LISTENERS ==============
function setupGlobalListeners() {
    // Theme Toggle
    if (DOM.themeToggle) {
        DOM.themeToggle.addEventListener('click', toggleTheme);
    }
    
    // Menu Toggle
    if (DOM.menuToggle && DOM.navLinks) {
        DOM.menuToggle.addEventListener('click', () => {
            DOM.navLinks.classList.toggle('active');
        });
        
        // Close menu on link click
        DOM.navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                DOM.navLinks.classList.remove('active');
            });
        });
    }
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Ctrl+K or Cmd+K to focus search
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            if (DOM.searchInput) {
                DOM.searchInput.focus();
            }
        }
        
        // Escape to clear search
        if (e.key === 'Escape' && document.activeElement === DOM.searchInput) {
            if (DOM.searchInput) {
                DOM.searchInput.value = '';
                DOM.searchInput.blur();
            }
        }
    });
}

// ============== LOAD VIDEOS ==============
async function loadVideos() {
    if (state.isLoading || !state.hasMore) return;
    
    state.isLoading = true;
    if (DOM.loading) DOM.loading.classList.add('show');
    
    try {
        const params = new URLSearchParams({
            page: state.currentPage,
            search: state.searchQuery,
            genre: state.currentGenre
        });
        
        // ✅ CORRECT: Homepage API call
        const response = await fetch(`${API_BASE}/api/home?${params}`);
        if (!response.ok) throw new Error('Failed to load videos');
        const data = await response.json();
        
        if (!data.videos || data.videos.length === 0) {
            state.hasMore = false;
            if (DOM.endResults) DOM.endResults.style.display = 'block';
            return;
        }
        
        renderVideos(data.videos);
        updateResultsCount(data.total);
        
        state.currentPage++;
        state.hasMore = data.hasMore;
        
        if (!state.hasMore && DOM.endResults) {
            DOM.endResults.style.display = 'block';
        }
        
    } catch (error) {
        console.error('Error loading videos:', error);
        showToast('Failed to load videos', 'error');
    } finally {
        state.isLoading = false;
        if (DOM.loading) DOM.loading.classList.remove('show');
    }
}

// ============== SEARCH ==============
async function performSearch() {
    if (!DOM.searchInput) return;
    
    const query = DOM.searchInput.value.trim();
    if (!query) {
        showToast('Please enter a search term', 'info');
        return;
    }
    
    state.searchQuery = query;
    state.currentPage = 1;
    state.hasMore = true;
    state.videos = [];
    if (DOM.results) DOM.results.innerHTML = '';
    if (DOM.endResults) DOM.endResults.style.display = 'none';
    
    showToast(`Searching for "${query}"...`, 'info');
    await loadVideos();
}

// ============== RENDER VIDEOS ==============
function renderVideos(videos) {
    if (!DOM.results) return;
    
    videos.forEach(video => {
        const card = createVideoCard(video);
        DOM.results.appendChild(card);
    });
}

function createVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.videoId = video.id;
    
    card.innerHTML = `
        <div class="thumbnail-wrapper">
            <img src="${video.thumbnail || 'https://via.placeholder.com/320x180?text=No+Thumbnail'}" 
                 alt="${video.title}" 
                 loading="lazy"
                 onerror="this.src='https://via.placeholder.com/320x180?text=No+Thumbnail'">
            <span class="duration-badge">${video.duration || 'N/A'}</span>
            ${video.quality && video.quality !== 'N/A' ? `<span class="quality-badge">${video.quality}</span>` : ''}
        </div>
        <div class="video-info">
            <div class="video-title">${video.title || 'Untitled'}</div>
            <div class="video-meta">
                ${video.uploader ? `<span class="uploader-name"><i class="fas fa-user"></i> ${video.uploader}</span>` : ''}
                <span class="views-count"><i class="fas fa-eye"></i> ${video.views || 0}</span>
            </div>
        </div>
    `;
    
    card.addEventListener('click', () => openVideo(video.id));
    
    return card;
}

// ============== OPEN VIDEO ==============
function openVideo(videoId) {
    window.location.href = `video.html?id=${encodeURIComponent(videoId)}`;
}

// ============== UPDATE RESULTS COUNT ==============
function updateResultsCount(count) {
    if (DOM.resultsCount) {
        DOM.resultsCount.textContent = `${count || 0} videos found`;
    }
}

// ============== LOAD VIDEO DETAILS ==============
async function loadVideoDetails(videoId) {
    try {
        showToast('Loading video...', 'info');
        
        // Mock data for now
        const mockVideo = {
            id: videoId,
            title: 'Goku vs Android 21 (DB) AI',
            uploader: 'Dairy Land',
            duration: '11min',
            quality: '1080p',
            rating: '100.00%',
            likes: '2920',
            dislikes: '645',
            views: '1,545,097',
            thumbnail: 'https://via.placeholder.com/800x450?text=Anime+Video',
            videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
            downloadUrl: '#',
            tags: ['anime', 'dragonball', 'action', 'fight', 'goku', 'android21'],
            relatedVideos: [
                {
                    id: '2',
                    title: 'Soaking My Stepsister Tight Shirt',
                    uploader: 'Panty Land',
                    duration: '20min',
                    rating: '100%',
                    thumbnail: 'https://via.placeholder.com/240x135?text=Related+1'
                },
                {
                    id: '3',
                    title: 'Busty Babe Rides His Cock',
                    uploader: 'Wrecked',
                    duration: '11min',
                    rating: '100%',
                    thumbnail: 'https://via.placeholder.com/240x135?text=Related+2'
                }
            ]
        };
        
        // Real API call (uncomment when backend is ready)
        // const response = await fetch(`${API_BASE}/api/video/${encodeURIComponent(videoId)}`);
        // if (!response.ok) throw new Error('Failed to load video');
        // const video = await response.json();
        
        const video = mockVideo;
        state.currentVideo = video;
        
        displayVideo(video);
        
    } catch (error) {
        console.error('Error loading video:', error);
        showToast('Failed to load video', 'error');
    }
}

// ============== DISPLAY VIDEO ==============
function displayVideo(video) {
    const titleEl = document.getElementById('videoTitle');
    const uploaderEl = document.getElementById('videoUploader');
    const durationEl = document.getElementById('videoDuration');
    const viewsEl = document.getElementById('videoViews');
    const qualityEl = document.getElementById('videoQuality');
    const ratingEl = document.getElementById('videoRating');
    const likesEl = document.getElementById('likesCount');
    const dislikesEl = document.getElementById('dislikesCount');
    const tagsContainer = document.getElementById('tagsContainer');
    const player = document.getElementById('mainVideo');
    const downloadBtn = document.getElementById('downloadBtn');
    const streamBtn = document.getElementById('streamBtn');
    const backButton = document.getElementById('backButton');
    
    if (titleEl) titleEl.textContent = video.title || 'Untitled';
    if (uploaderEl) uploaderEl.textContent = video.uploader || 'Unknown';
    if (durationEl) {
        durationEl.textContent = video.duration || 'N/A';
        durationEl.className = 'meta-duration';
    }
    if (viewsEl) {
        viewsEl.textContent = video.views || '0';
        viewsEl.className = 'meta-views';
    }
    if (qualityEl) {
        qualityEl.textContent = video.quality || 'N/A';
        qualityEl.className = 'meta-quality';
    }
    if (ratingEl) ratingEl.textContent = `⭐ ${video.rating || 'N/A'}`;
    if (likesEl) likesEl.textContent = video.likes || '0';
    if (dislikesEl) dislikesEl.textContent = video.dislikes || '0';
    
    // Tags
    if (tagsContainer) {
        tagsContainer.innerHTML = '';
        if (video.tags && video.tags.length > 0) {
            video.tags.forEach(tag => {
                const tagEl = document.createElement('span');
                tagEl.className = 'tag';
                tagEl.textContent = `#${tag}`;
                tagsContainer.appendChild(tagEl);
            });
        } else {
            tagsContainer.innerHTML = '<span class="tag">No tags</span>';
        }
    }
    
    // Video Player
    if (player) {
        if (video.videoUrl) {
            player.src = video.videoUrl;
            player.poster = video.thumbnail || '';
        }
    }
    
    // Download Button
    if (downloadBtn) {
        if (video.downloadUrl && video.downloadUrl !== '#') {
            downloadBtn.onclick = () => {
                window.open(video.downloadUrl, '_blank');
            };
        } else {
            downloadBtn.style.opacity = '0.5';
            downloadBtn.style.cursor = 'not-allowed';
            downloadBtn.title = 'Download not available';
        }
    }
    
    // Stream Button
    if (streamBtn && player) {
        streamBtn.onclick = () => {
            player.play();
        };
    }
    
    // Related Videos
    if (video.relatedVideos && video.relatedVideos.length > 0) {
        renderRelatedVideos(video.relatedVideos);
    }
    
    // Back Button
    if (backButton) {
        backButton.addEventListener('click', () => {
            window.location.href = 'index.html';
        });
    }
}

// ============== RENDER RELATED VIDEOS ==============
function renderRelatedVideos(relatedVideos) {
    const grid = document.getElementById('relatedGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    relatedVideos.forEach(video => {
        const card = document.createElement('div');
        card.className = 'related-card';
        
        card.innerHTML = `
            <a href="video.html?id=${encodeURIComponent(video.id || video.url)}">
                <div class="related-thumb">
                    <img src="${video.thumbnail || 'https://via.placeholder.com/240x135?text=No+Thumbnail'}" 
                         alt="${video.title}" 
                         loading="lazy"
                         onerror="this.src='https://via.placeholder.com/240x135?text=No+Thumbnail'">
                    <span class="thumb-duration">${video.duration || 'N/A'}</span>
                </div>
                <div class="related-info">
                    <div class="related-title">${video.title || 'Untitled'}</div>
                    <div class="related-meta">
                        <span class="related-uploader">${video.uploader || 'Unknown'}</span>
                        <span class="related-rating">⭐ ${video.rating || 'N/A'}</span>
                    </div>
                </div>
            </a>
        `;
        
        grid.appendChild(card);
    });
}

// ============== SCROLL HANDLING ==============
function setupScroll() {
    window.addEventListener('scroll', () => {
        // Back to top button
        if (DOM.backToTop) {
            if (window.scrollY > 400) {
                DOM.backToTop.classList.add('show');
            } else {
                DOM.backToTop.classList.remove('show');
            }
        }
        
        // Infinite scroll - only on homepage
        if (!isVideoPage) {
            const scrollY = window.scrollY;
            const windowHeight = window.innerHeight;
            const documentHeight = document.documentElement.scrollHeight;
            
            if (scrollY + windowHeight >= documentHeight - 500) {
                loadVideos();
            }
        }
    });
    
    // Back to top click
    if (DOM.backToTop) {
        DOM.backToTop.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
}

// ============== THEME ==============
function toggleTheme() {
    document.body.classList.toggle('light-theme');
    if (DOM.themeToggle) {
        const icon = DOM.themeToggle.querySelector('i');
        if (document.body.classList.contains('light-theme')) {
            icon.className = 'fas fa-sun';
            localStorage.setItem('theme', 'light');
        } else {
            icon.className = 'fas fa-moon';
            localStorage.setItem('theme', 'dark');
        }
    }
}

function loadTheme() {
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-theme');
        if (DOM.themeToggle) {
            DOM.themeToggle.querySelector('i').className = 'fas fa-sun';
        }
    }
}

// ============== TOAST ==============
function showToast(message, type = 'info') {
    if (!DOM.toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'info-circle';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'exclamation-circle';
    
    toast.innerHTML = `
        <i class="fas fa-${icon}"></i>
        <span>${message}</span>
    `;
    
    DOM.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ============== EXPOSE FOR CONSOLE DEBUG ==============
window.__genesis = {
    state,
    loadVideos,
    performSearch,
    showToast,
    DOM
};

console.log('🔥 The Genesis loaded successfully!');
console.log('📚 Dev Zikky Tech');
console.log('💡 Press Ctrl+K to search');



