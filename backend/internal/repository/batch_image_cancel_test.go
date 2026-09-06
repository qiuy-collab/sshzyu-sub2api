package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestBatchImageRepository_CancelFinalizesPendingItemsAtomically(t *testing.T) {
	for _, failItems := range []bool{false, true} {
		name := "commit"
		if failItems {
			name = "rollback_on_item_failure"
		}
		t.Run(name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer db.Close()
			repo := NewBatchImageRepository(db)
			now := time.Now()
			mock.ExpectBegin()
			mock.ExpectQuery("SELECT status FROM batch_image_jobs WHERE batch_id = \\$1 FOR UPDATE").WithArgs("cancel-test").WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow(service.BatchImageJobStatusCreated))
			mock.ExpectExec("UPDATE batch_image_jobs").WithArgs("cancel-test", service.BatchImageJobStatusCancelled, now, nil, nil).WillReturnResult(sqlmock.NewResult(0, 1))
			update := mock.ExpectExec("UPDATE batch_image_items\\s+SET status = 'cancelled'\\s+WHERE job_id = \\$1 AND status = 'pending'").WithArgs("cancel-test")
			if failItems {
				update.WillReturnError(errors.New("item update failed"))
				mock.ExpectRollback()
			} else {
				update.WillReturnResult(sqlmock.NewResult(0, 2))
				mock.ExpectCommit()
			}
			err = repo.TransitionBatchImageJobStatus(context.Background(), "cancel-test", service.BatchImageJobStatusCancelled, service.BatchImageTransitionOptions{Now: &now})
			if failItems {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.NoError(t, mock.ExpectationsWereMet())
		})
	}
}
