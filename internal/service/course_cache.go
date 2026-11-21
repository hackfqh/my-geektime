package service

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/zkep/my-geektime/internal/global"
	"github.com/zkep/my-geektime/internal/model"
	"github.com/zkep/my-geektime/internal/types/collect"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrCourseCacheInProgress = errors.New("course cache is in progress")

var (
	courseCacheMu      sync.Mutex
	activeCacheWorkers = make(map[string]int)
)

// TrackCourseCacheWorker keeps a refresh from replacing tasks while
// a worker is writing the same course's media files.
func TrackCourseCacheWorker(courseTaskID string) func() {
	courseCacheMu.Lock()
	activeCacheWorkers[courseTaskID]++
	courseCacheMu.Unlock()
	return func() {
		courseCacheMu.Lock()
		defer courseCacheMu.Unlock()
		activeCacheWorkers[courseTaskID]--
		if activeCacheWorkers[courseTaskID] == 0 {
			delete(activeCacheWorkers, courseTaskID)
		}
	}
}

// SaveCourseCache replaces the active cache for a course in one transaction.
func SaveCourseCache(ctx context.Context, course *model.Task, chapters []*model.Task, complete bool) (string, error) {
	courseCacheMu.Lock()
	defer courseCacheMu.Unlock()

	db := global.DB.WithContext(ctx)
	// Look up the course before starting the write transaction. In SQLite
	// a read transaction cannot become a writer while another writer waits.
	var existing []model.Task
	if err := db.Select("id", "task_id").
		Where("task_type = ? AND other_id = ? AND deleted_at = 0", TASK_TYPE_PRODUCT, course.OtherId).
		Order("id ASC").Find(&existing).Error; err != nil {
		return "", err
	}

	taskID := course.TaskId
	err := db.Transaction(func(tx *gorm.DB) error {
		if len(existing) == 0 {
			if err := tx.Create(course).Error; err != nil {
				return err
			}
			return tx.Create(chapters).Error
		}

		primary := existing[0]
		taskID = primary.TaskId
		if activeCacheWorkers[taskID] > 0 {
			return ErrCourseCacheInProgress
		}
		if err := refreshCourseCache(tx, primary, course, chapters, complete); err != nil {
			return err
		}
		for _, duplicate := range existing[1:] {
			if !complete {
				// A partial response can still supersede a copy whose chapters
				// are all present in the surviving course.
				mainChapters := tx.Table("tasks AS main_chapters").Select("1").
					Where("main_chapters.task_pid = ? AND main_chapters.task_type = ? AND main_chapters.deleted_at = 0", taskID, TASK_TYPE_ARTICLE).
					Where("main_chapters.other_id = duplicate_chapters.other_id")
				var additional int64
				if err := tx.Table("tasks AS duplicate_chapters").
					Where("duplicate_chapters.task_pid = ? AND duplicate_chapters.task_type = ? AND duplicate_chapters.deleted_at = 0", duplicate.TaskId, TASK_TYPE_ARTICLE).
					Where("NOT EXISTS (?)", mainChapters).Count(&additional).Error; err != nil {
					return err
				}
				if additional > 0 {
					continue
				}
			}
			if err := archiveDuplicateCourse(tx, duplicate.TaskId, taskID); err != nil {
				return err
			}
		}
		return nil
	})
	return taskID, err
}

func refreshCourseCache(tx *gorm.DB, current model.Task, course *model.Task, chapters []*model.Task, complete bool) error {
	if err := updateCachedTask(tx, current.Id, course); err != nil {
		return err
	}
	var oldChapters []model.Task
	if err := tx.Select("id", "other_id").
		Where("task_pid = ? AND task_type = ? AND deleted_at = 0", current.TaskId, TASK_TYPE_ARTICLE).
		Order("id ASC").Find(&oldChapters).Error; err != nil {
		return err
	}
	byArticleID := make(map[string]int64, len(oldChapters))
	for _, chapter := range oldChapters {
		if _, exists := byArticleID[chapter.OtherId]; !exists {
			byArticleID[chapter.OtherId] = chapter.Id
		}
	}

	kept := make(map[int64]bool, len(chapters))
	for _, chapter := range chapters {
		chapter.TaskPid = current.TaskId
		id, exists := byArticleID[chapter.OtherId]
		if !exists {
			if err := tx.Create(chapter).Error; err != nil {
				return err
			}
			continue
		}
		if err := updateCachedTask(tx, id, chapter); err != nil {
			return err
		}
		kept[id] = true
	}
	if !complete {
		return nil
	}
	var removed []int64
	for _, chapter := range oldChapters {
		if !kept[chapter.Id] {
			removed = append(removed, chapter.Id)
		}
	}
	if len(removed) == 0 {
		return nil
	}
	return tx.Model(&model.Task{}).Where("id IN ?", removed).Update("deleted_at", time.Now().Unix()).Error
}

func updateCachedTask(tx *gorm.DB, id int64, task *model.Task) error {
	task.Status = TASK_STATUS_PENDING
	return tx.Model(&model.Task{}).Where("id = ?", id).
		Select("TaskName", "Cover", "Raw", "OtherType", "OtherForm", "OtherGroup", "OtherTag",
			"Status", "Bstatus", "Statistics", "Ciphertext", "RewriteHls").
		Updates(task).Error
}

func archiveDuplicateCourse(tx *gorm.DB, duplicateID, primaryID string) error {
	now := time.Now().Unix()
	if err := tx.Model(&model.Task{}).
		Where("deleted_at = 0 AND (task_id = ? OR task_pid = ?)", duplicateID, duplicateID).
		Update("deleted_at", now).Error; err != nil {
		return err
	}
	var favorites []model.Collect
	if err := tx.Where("collect_id = ? AND collect_type = ? AND deleted_at = 0", duplicateID, collect.CollectTask).
		Find(&favorites).Error; err != nil {
		return err
	}
	for _, favorite := range favorites {
		favoriteID := favorite.Id
		favorite.Id = 0
		favorite.CollectId = primaryID
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&favorite).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.Collect{}).Where("id = ?", favoriteID).Update("deleted_at", now).Error; err != nil {
			return err
		}
	}
	return nil
}
