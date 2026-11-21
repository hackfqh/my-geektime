package v2

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/zkep/my-geektime/internal/global"
	"github.com/zkep/my-geektime/internal/model"
	"github.com/zkep/my-geektime/internal/service"
	"github.com/zkep/my-geektime/internal/types/geek"
	"github.com/zkep/my-geektime/internal/types/sys_dict"
	"github.com/zkep/my-geektime/internal/types/task"
	"github.com/zkep/my-geektime/libs/utils"
)

type Product struct{}

func NewProduct() *Product {
	return &Product{}
}

func (p *Product) Download(c *gin.Context) {
	var req geek.DowloadRequest
	if err := c.BindJSON(&req); err != nil {
		global.FAIL(c, "fail.msg", err)
		return
	}
	accessToken := c.GetString(global.AccessToken)
	if accessToken == "" {
		global.FAIL(c, "product.no_cookie")
		return
	}
	if req.Pid <= 0 {
		global.FAIL(c, "product.no_exists_pid")
		return
	}
	ctx := c.Request.Context()
	resp, err := service.GetArticles(ctx, accessToken,
		geek.ArticlesListRequest{
			Cid:   fmt.Sprintf("%d", req.Pid),
			Order: "earliest",
			Prev:  1,
			Size:  500,
		})
	if err != nil {
		global.FailWithError(c, err)
		return
	}
	if resp.Code != 0 || len(resp.Data.List) == 0 {
		global.FAIL(c, "product.api_busy")
		return
	}
	var product model.Product
	if err := global.DB.Model(&model.Product{}).
		Where(&model.Product{Pid: fmt.Sprintf("%d", req.Pid)}).Find(&product).Error; err != nil {
		global.FAIL(c, "fail.msg", err.Error())
		return
	}
	if product.Pid == "" {
		ret, err := service.GetColumnInfo(ctx, accessToken,
			geek.ColumnRequest{ProductID: req.Pid, WithRecommendArticle: true})
		if err != nil {
			global.FAIL(c, "fail.msg", err.Error())
			return
		}
		product.Title = ret.Data.Title
		product.Cover = ret.Data.Cover.Square
		product.Raw, _ = json.Marshal(ret.Data)
	}
	jobId := utils.HalfUUID()
	job := &model.Task{
		TaskId:     jobId,
		TaskName:   product.Title,
		TaskType:   service.TASK_TYPE_PRODUCT,
		OtherId:    fmt.Sprintf("%d", req.Pid),
		Cover:      product.Cover,
		Raw:        product.Raw,
		OtherType:  product.OtherType,
		OtherForm:  product.OtherForm,
		OtherGroup: product.OtherGroup,
		OtherTag:   product.OtherTag,
	}
	seen := make(map[int64]bool, len(resp.Data.List))
	tasks := make([]*model.Task, 0, len(resp.Data.List))
	complete := !resp.Data.Page.More
	for _, article := range resp.Data.List {
		if article.ID <= 0 || article.ArticleTitle == "" {
			complete = false
			continue
		}
		if seen[article.ID] {
			continue
		}
		seen[article.ID] = true
		raw, _ := json.Marshal(article)
		cover := article.ArticleCover
		if cover == "" {
			cover = article.VideoCover
		}
		item := model.Task{
			TaskPid:    jobId,
			TaskId:     utils.HalfUUID(),
			OtherId:    fmt.Sprintf("%d", article.ID),
			TaskName:   article.ArticleTitle,
			TaskType:   service.TASK_TYPE_ARTICLE,
			Cover:      cover,
			Raw:        raw,
			OtherType:  product.OtherType,
			OtherForm:  product.OtherForm,
			OtherGroup: product.OtherGroup,
			OtherTag:   product.OtherTag,
		}
		if global.CONF.Site.Download {
			item.Bstatus = service.TASK_STATUS_PENDING
		}
		tasks = append(tasks, &item)
	}
	count := len(tasks)
	if count == 0 {
		global.FAIL(c, "product.api_busy")
		return
	}
	complete = complete && int64(count) >= resp.Data.Page.Count
	statistics := task.TaskStatistics{
		Count: count,
		Items: map[int]int{
			service.TASK_STATUS_PENDING:  count,
			service.TASK_STATUS_RUNNING:  0,
			service.TASK_STATUS_FINISHED: 0,
			service.TASK_STATUS_ERROR:    0,
		},
	}
	job.Statistics, _ = json.Marshal(statistics)
	if global.CONF.Site.Download {
		job.Bstatus = service.TASK_STATUS_PENDING
	}
	jobId, err = service.SaveCourseCache(ctx, job, tasks, complete)
	if errors.Is(err, service.ErrCourseCacheInProgress) {
		global.FAIL(c, "product.cache_in_progress")
		return
	}
	if err != nil {
		global.FAIL(c, "fail.msg", err.Error())
		return
	}
	result := geek.DowloadResponse{JobID: jobId}
	global.OK(c, result)
}

func (p *Product) ProductList(c *gin.Context) {
	var req geek.DailyProductRequest
	if err := c.ShouldBind(&req); err != nil {
		global.FAIL(c, "fail.msg", err.Error())
		return
	}
	if req.Size <= 0 {
		req.Size = 20
	}
	if req.Prev <= 0 {
		req.Prev = 1
	}
	req.Prev = req.Prev - 1
	accessToken := global.CONF.Site.Cookie.Geektime
	resp, err := service.GetProduct(c, accessToken, req)
	if err != nil {
		global.FAIL(c, "fail.msg", err.Error())
		return
	}
	ret := geek.ProductListResponse{Rows: make([]geek.ProductListRow, 0)}
	ret.Score = resp.Data.Page.Score
	ret.Count = resp.Data.Page.Count
	if resp.Data.Page.Count == 0 {
		ret.HasNext = resp.Data.Page.More
	}
	for _, v := range resp.Data.List {
		row := geek.ProductListRow{
			ID:            v.ID,
			Title:         v.Title,
			Subtitle:      v.Subtitle,
			Intro:         v.Intro,
			IntroHTML:     v.IntroHTML,
			Ucode:         v.Ucode,
			IsFinish:      v.IsFinish,
			IsVideo:       v.IsVideo,
			IsAudio:       v.IsAudio,
			IsColumn:      v.IsColumn,
			IsCore:        v.IsCore,
			IsDailylesson: v.IsDailylesson,
			IsUniversity:  v.IsUniversity,
			IsOpencourse:  v.IsOpencourse,
			IsQconp:       v.IsQconp,
			IsMentor:      v.IsMentor,
			IsSale:        v.IsSale,
			Sale:          v.Price.Sale,
			SaleType:      v.Price.SaleType,
			Share:         v.Share,
			Author:        v.Author,
			Cover:         v.Cover,
			Article:       v.Article,
		}
		row.Cover.Square = service.URLProxyReplace(row.Cover.Square)
		row.Author.Avatar = service.URLProxyReplace(row.Author.Avatar)
		if len(row.IntroHTML) > 0 {
			if introHTML, err1 := service.HtmlURLProxyReplace(row.IntroHTML); err1 == nil {
				row.IntroHTML = introHTML
			}
		}
		row.Redirect = sys_dict.ProductURLWithType(v.Type, v.ID)
		ret.Rows = append(ret.Rows, row)
	}
	global.OK(c, ret)
}

func (p *Product) PvipProductList(c *gin.Context) {
	var req geek.PvipProductRequest
	if err := c.ShouldBind(&req); err != nil {
		global.FAIL(c, "fail.msg", err.Error())
		return
	}
	if req.Tag > 0 {
		req.TagIds = []int32{req.Tag}
	}
	req.Size = req.PerPage
	req.Prev = req.Page
	accessToken := global.CONF.Site.Cookie.Geektime
	ret := geek.ProductListResponse{Rows: make([]geek.ProductListRow, 0)}
	if len(req.Keyword) > 0 {
		searchReq := geek.SearchRequest{
			Keyword:  req.Keyword,
			Category: "product",
			Platform: "pc",
			Prev:     req.Prev,
			Size:     req.Size + 1,
		}
		searchRet, err := service.GeekTimeSearch(c, accessToken, searchReq)
		if err != nil {
			global.FAIL(c, "fail.msg", err.Error())
			return
		}
		ret.Count = searchRet.Data.Page.Count
		if len(searchRet.Data.List) > req.Size {
			ret.HasNext = true
			searchRet.Data.List = searchRet.Data.List[:req.Size]
		}
		for _, v := range searchRet.Data.List {
			if v.ItemType != "product" {
				continue
			}
			item := v.Product
			row := geek.ProductListRow{
				ID:       item.ID,
				Title:    item.Title,
				Subtitle: item.Subtitle,
				IsVideo:  item.Type == "c3",
				IsAudio:  item.Type == "c1",
			}
			row.Article.Count = item.TotalLesson
			row.Author.Name = item.AuthorName
			row.Author.Info = item.AuthorIntro
			row.Cover.Square = item.Cover
			row.Cover.Square = service.URLProxyReplace(row.Cover.Square)
			if len(row.IntroHTML) > 0 {
				if introHTML, err1 := service.HtmlURLProxyReplace(row.IntroHTML); err1 == nil {
					row.IntroHTML = introHTML
				}
			}
			ret.Rows = append(ret.Rows, row)
		}

		global.OK(c, ret)
		return
	}
	resp, err := service.GetPvipProduct(c, accessToken, req)
	if err != nil {
		global.FAIL(c, "fail.msg", err.Error())
		return
	}
	ret.Count = resp.Data.Page.Total
	if resp.Data.Page.Total == 0 {
		ret.HasNext = resp.Data.Page.More
	}
	for _, v := range resp.Data.Products {
		row := geek.ProductListRow{
			ID:            v.ID,
			Title:         v.Title,
			Subtitle:      v.Subtitle,
			Intro:         v.Intro,
			IntroHTML:     v.IntroHTML,
			Ucode:         v.Ucode,
			IsFinish:      v.IsFinish,
			IsVideo:       v.IsVideo,
			IsAudio:       v.IsAudio,
			IsColumn:      v.IsColumn,
			IsCore:        v.IsCore,
			IsDailylesson: v.IsDailylesson,
			IsUniversity:  v.IsUniversity,
			IsOpencourse:  v.IsOpencourse,
			IsQconp:       v.IsQconp,
			IsMentor:      v.IsMentor,
			IsSale:        v.IsSale,
			Sale:          v.Price.Sale,
			SaleType:      v.Price.SaleType,
			Share:         v.Share,
			Author:        v.Author,
			Cover:         v.Cover,
			Article:       v.Article,
		}
		row.Cover.Square = service.URLProxyReplace(row.Cover.Square)
		row.Author.Avatar = service.URLProxyReplace(row.Author.Avatar)
		if len(row.IntroHTML) > 0 {
			if introHTML, err1 := service.HtmlURLProxyReplace(row.IntroHTML); err1 == nil {
				row.IntroHTML = introHTML
			}
		}
		row.Redirect = sys_dict.ProductURLWithType(v.Type, v.ID)
		ret.Rows = append(ret.Rows, row)
	}
	global.OK(c, ret)
}
