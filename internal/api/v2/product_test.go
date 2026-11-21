package v2

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zkep/my-geektime/internal/config"
	"github.com/zkep/my-geektime/internal/global"
	"github.com/zkep/my-geektime/internal/model"
	"github.com/zkep/my-geektime/internal/service"
	"github.com/zkep/my-geektime/internal/types/collect"
	"github.com/zkep/my-geektime/libs/db"
	"github.com/zkep/my-geektime/libs/rest"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

type courseTransport func(*http.Request) (*http.Response, error)

func (f courseTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestDownloadReplacesCachedCourse(t *testing.T) {
	database, err := db.NewGORM("sqlite", filepath.Join(t.TempDir(), "cache.db"))()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.AutoMigrate(&model.Task{}, &model.Product{}, &model.ArticleSimple{}, &model.Collect{}); err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.Product{Pid: "42", Title: "Course"}).Error; err != nil {
		t.Fatal(err)
	}
	metadata := []model.ArticleSimple{{Aid: "100"}, {Aid: "101"}, {Aid: "102"}}
	if err := database.Create(&metadata).Error; err != nil {
		t.Fatal(err)
	}
	localizer, err := rest.InitI18nWithFsFile()
	if err != nil {
		t.Fatal(err)
	}
	previousDB, previousConfig, previousLog, previousClient := global.DB, global.CONF, global.LOG, global.HttpClient
	previousOK, previousFail := global.OK, global.FAIL
	global.DB, global.CONF, global.LOG = database, &config.Config{}, zap.NewNop()
	renderer := rest.NewI18nRender(localizer)
	global.OK, global.FAIL = renderer.OK, renderer.FAIL
	t.Cleanup(func() {
		global.DB, global.CONF, global.LOG, global.HttpClient = previousDB, previousConfig, previousLog, previousClient
		global.OK, global.FAIL = previousOK, previousFail
	})

	var articles string
	global.HttpClient = &http.Client{Transport: courseTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(articles)),
		}, nil
	})}
	product := NewProduct()
	router := gin.New()
	router.POST("/product/download", func(c *gin.Context) {
		c.Set(global.AccessToken, "test-cookie")
		product.Download(c)
	})
	// GetArticles also syncs metadata in the background. Wait for that
	// work to finish before restoring the application's globals.
	synced := make(chan error, 4)
	if err := database.Callback().Update().After("gorm:commit_or_rollback_transaction").
		Register("test:article_synced", func(tx *gorm.DB) {
			if tx.Statement.Table == "article_simples" {
				synced <- tx.Error
			}
		}); err != nil {
		t.Fatal(err)
	}
	waitForMetadata := func(count int) {
		t.Helper()
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for range count {
			select {
			case err := <-synced:
				if err != nil {
					t.Errorf("article metadata sync: %v", err)
				}
			case <-timer.C:
				t.Fatal("timed out waiting for article metadata")
			}
		}
	}
	download := func(status int) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/product/download", strings.NewReader(`{"pid":42}`))
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var response struct {
			Status int
			Data   struct {
				JobID string `json:"job_id"`
			}
		}
		if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil || response.Status != status || (status == 0 && response.Data.JobID == "") {
			t.Errorf("cache response: %s (decode error: %v)", res.Body, err)
		}
		return response.Data.JobID
	}

	articles = `{"data":{"list":[{"id":100,"article_title":"Original"},{"id":101,"article_title":"Removed"}]}}`
	first := download(0)
	waitForMetadata(2)
	var original model.Task
	if err := database.Where("task_pid = ? AND other_id = ?", first, "100").First(&original).Error; err != nil {
		t.Fatal(err)
	}
	media := `{"object":"local://object/existing.mp3"}`
	if err := database.Model(&model.Task{}).Where("id = ?", original.Id).
		Update("message", []byte(media)).Error; err != nil {
		t.Fatal(err)
	}
	legacy := []model.Task{
		{TaskId: "legacy", OtherId: "42", TaskType: service.TASK_TYPE_PRODUCT},
		{TaskId: "legacy-chapter", TaskPid: "legacy", OtherId: "100", TaskType: service.TASK_TYPE_ARTICLE},
	}
	if err := database.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	favorite := model.Collect{Uid: "reader", CollectId: "legacy", CollectType: collect.CollectTask, Category: "3"}
	if err := database.Create(&favorite).Error; err != nil {
		t.Fatal(err)
	}

	articles = `{"data":{"list":[{"id":100,"article_title":"Partial"}],"page":{"count":2}}}`
	stopWorker := service.TrackCourseCacheWorker(first)
	download(100)
	stopWorker()
	waitForMetadata(1)
	var stillOriginal model.Task
	if err := database.Where("task_id = ?", original.TaskId).First(&stillOriginal).Error; err != nil {
		t.Fatal(err)
	}
	if stillOriginal.TaskName != "Original" {
		t.Fatalf("an active worker's chapter was replaced: %q", stillOriginal.TaskName)
	}
	download(0)
	waitForMetadata(1)
	var removedCount int64
	if err := database.Model(&model.Task{}).
		Where("task_pid = ? AND deleted_at <> 0", first).Count(&removedCount).Error; err != nil {
		t.Fatal(err)
	}
	if removedCount != 0 {
		t.Fatalf("an incomplete list archived %d chapters from the main course", removedCount)
	}
	var activeCourses int64
	if err := database.Model(&model.Task{}).
		Where("task_type = ? AND deleted_at = 0", service.TASK_TYPE_PRODUCT).Count(&activeCourses).Error; err != nil {
		t.Fatal(err)
	}
	if activeCourses != 1 {
		t.Fatalf("an incomplete list left %d course copies with the same chapters", activeCourses)
	}

	articles = `{"data":{"list":[{"id":100,"article_title":"Refreshed"},{"id":102,"article_title":"Added"}]}}`
	var downloads sync.WaitGroup
	var second, third string
	downloads.Go(func() { second = download(0) })
	downloads.Go(func() { third = download(0) })
	downloads.Wait()
	waitForMetadata(4)

	var courses []model.Task
	if err := database.Where("task_type = ? AND deleted_at = 0", service.TASK_TYPE_PRODUCT).Find(&courses).Error; err != nil {
		t.Fatal(err)
	}
	if len(courses) != 1 || second != first || third != first {
		t.Fatalf("expected one course with original job ID %q, got %d courses and job IDs %q and %q", first, len(courses), second, third)
	}
	var chapters []model.Task
	if err := database.Where("task_pid = ? AND deleted_at = 0", second).Order("other_id").Find(&chapters).Error; err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 2 || chapters[0].TaskId != original.TaskId || chapters[0].TaskName != "Refreshed" || chapters[1].OtherId != "102" {
		t.Fatalf("expected refreshed chapter and new chapter, got %v", chapters)
	}
	if string(chapters[0].Message) != media {
		t.Fatalf("refresh lost the downloaded media: %s", chapters[0].Message)
	}
	var favorites []model.Collect
	if err := database.Where("deleted_at = 0").Find(&favorites).Error; err != nil {
		t.Fatal(err)
	}
	if len(favorites) != 1 || favorites[0].CollectId != first || favorites[0].Category != "3" {
		t.Fatalf("expected one favorite for the surviving course, got %v", favorites)
	}
}
